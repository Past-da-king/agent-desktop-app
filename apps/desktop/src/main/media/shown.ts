/**
 * The local files an agent has chosen to show in the chat: a video, a picture or a sound, and nothing else.
 *
 * The window asks for one through the agent-media:// scheme (media/serve.ts) with an opaque token. A token exists only
 * because an agent showed that exact file with show_media, so no path on disk is reachable without one. A URL never
 * carries a path: "..", a link or a drive trick has nothing to work on, because every path is resolved and checked
 * here, once, before it is kept. Read-only, and never a folder.
 *
 * The list is kept beside the app's own data so a card in an older chat still plays after a restart. It is capped, and
 * a file that has gone is dropped when the list is read.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute } from 'node:path'

export type MediaKind = 'video' | 'image' | 'audio'

/** What the window can play or draw, by file extension. Nothing else is ever served. */
export const MEDIA_TYPES: Readonly<Record<string, { mime: string; kind: MediaKind }>> = {
  '.mp4': { mime: 'video/mp4', kind: 'video' },
  '.m4v': { mime: 'video/mp4', kind: 'video' },
  '.mov': { mime: 'video/quicktime', kind: 'video' },
  '.webm': { mime: 'video/webm', kind: 'video' },
  '.ogv': { mime: 'video/ogg', kind: 'video' },
  '.png': { mime: 'image/png', kind: 'image' },
  '.jpg': { mime: 'image/jpeg', kind: 'image' },
  '.jpeg': { mime: 'image/jpeg', kind: 'image' },
  '.webp': { mime: 'image/webp', kind: 'image' },
  '.gif': { mime: 'image/gif', kind: 'image' },
  '.avif': { mime: 'image/avif', kind: 'image' },
  '.svg': { mime: 'image/svg+xml', kind: 'image' },
  '.mp3': { mime: 'audio/mpeg', kind: 'audio' },
  '.m4a': { mime: 'audio/mp4', kind: 'audio' },
  '.aac': { mime: 'audio/aac', kind: 'audio' },
  '.wav': { mime: 'audio/wav', kind: 'audio' },
  '.ogg': { mime: 'audio/ogg', kind: 'audio' },
  '.oga': { mime: 'audio/ogg', kind: 'audio' },
  '.opus': { mime: 'audio/ogg', kind: 'audio' },
  '.flac': { mime: 'audio/flac', kind: 'audio' },
}

/** A file the window may show: its token, the real path behind it, and enough to draw the card. */
export interface ShownFile {
  token: string
  /** The real, resolved path on this computer. Never leaves the main process except in the card's own details. */
  path: string
  name: string
  mime: string
  kind: MediaKind
  size: number
  /** When an agent showed it, epoch ms. */
  at: number
}

export type ShowResult = { ok: true; file: ShownFile } | { ok: false; why: string }

/** The extensions list, for a message that says what the app can show. */
export function mediaTypeList(): string {
  const video = Object.keys(MEDIA_TYPES).filter((ext) => MEDIA_TYPES[ext]?.kind === 'video')
  const image = Object.keys(MEDIA_TYPES).filter((ext) => MEDIA_TYPES[ext]?.kind === 'image')
  const audio = Object.keys(MEDIA_TYPES).filter((ext) => MEDIA_TYPES[ext]?.kind === 'audio')
  const bare = (list: string[]): string => list.map((ext) => ext.slice(1)).join(', ')
  return `video (${bare(video)}), pictures (${bare(image)}) and sound (${bare(audio)})`
}

/** The biggest file the window will stream whole. A film is fine; a raw disk image is not. */
export const MAX_MEDIA_BYTES = 4 * 1024 * 1024 * 1024

/** How many shown files are kept. The oldest fall off the end. */
const MAX_KEPT = 500

/** The scheme and host every shown file is addressed by. */
export const MEDIA_SCHEME = 'agent-media'
export const MEDIA_HOST = 'f'

/** agent-media://f/<32 hex>. The address carries no path, so there is nothing to traverse. */
export function shownUrl(token: string): string {
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${token}`
}

/** The token an agent-media:// address names, or null when it is not one of ours. */
export function tokenOf(url: string): string | null {
  const m = /^agent-media:\/\/f\/([a-f0-9]{32})\/?(?:[?#].*)?$/i.exec(url.trim())
  return m === null ? null : (m[1] ?? '').toLowerCase()
}

function tokenFor(realPath: string): string {
  return createHash('sha256').update(realPath, 'utf8').digest('hex').slice(0, 32)
}

interface Kept {
  version: 1
  files: ShownFile[]
}

/**
 * What has been shown. One of these lives for the whole app: the tools add to it, the scheme reads from it, and it is
 * written to disk after every change so a card from yesterday still plays today.
 */
export class ShownMedia {
  private readonly index = new Map<string, ShownFile>()
  private read = false

  constructor(private readonly file: string) {}

  /** Show one file: resolved, checked, and kept. The path may come with quotes or a ~ or a trailing space. */
  show(raw: string): ShowResult {
    this.load()
    const input = cleanPath(raw)
    if (input === '') return { ok: false, why: 'show_media needs the full path of a file on this computer.' }
    if (!isAbsolute(input)) {
      return { ok: false, why: `${input} is not a full path. Give the whole path, drive letter and folders, as files_list shows it.` }
    }
    if (!existsSync(input)) return { ok: false, why: `There is no file at ${input}.` }
    let real: string
    try {
      // Links and ".." resolve here, once: what is kept is the real file, and nothing above it.
      real = realpathSync(input)
    } catch {
      return { ok: false, why: `That file cannot be read: ${input}.` }
    }
    let size = 0
    try {
      const stat = statSync(real)
      if (!stat.isFile()) return { ok: false, why: `${real} is a folder, not a file. Pick a file inside it.` }
      size = stat.size
    } catch {
      return { ok: false, why: `That file cannot be read: ${real}.` }
    }
    const type = MEDIA_TYPES[extname(real).toLowerCase()]
    if (type === undefined) {
      return { ok: false, why: `The app cannot show ${basename(real)}. It shows ${mediaTypeList()}. Convert it first, for example with ffmpeg.` }
    }
    if (size > MAX_MEDIA_BYTES) {
      return { ok: false, why: `${basename(real)} is ${Math.round(size / 1024 / 1024 / 1024)} GB, too big to show in the chat. The limit is 4 GB.` }
    }
    const file: ShownFile = { token: tokenFor(real), path: real, name: basename(real), mime: type.mime, kind: type.kind, size, at: Date.now() }
    this.index.set(file.token, file)
    this.save()
    return { ok: true, file }
  }

  /** The file a token names, if an agent showed it and it is still there. */
  get(token: string): ShownFile | null {
    this.load()
    const found = this.index.get(token.trim().toLowerCase())
    if (found === undefined) return null
    try {
      if (!statSync(found.path).isFile()) return null
    } catch {
      return null
    }
    return found
  }

  list(): ShownFile[] {
    this.load()
    return [...this.index.values()].sort((a, b) => b.at - a.at)
  }

  private load(): void {
    if (this.read) return
    this.read = true
    let kept: Kept | null = null
    try {
      kept = JSON.parse(readFileSync(this.file, 'utf8')) as Kept
    } catch {
      kept = null
    }
    if (kept === null || !Array.isArray(kept.files)) return
    for (const entry of kept.files) {
      if (typeof entry.token !== 'string' || typeof entry.path !== 'string') continue
      if (!existsSync(entry.path)) continue
      this.index.set(entry.token, entry)
    }
  }

  private save(): void {
    const files = [...this.index.values()].sort((a, b) => b.at - a.at).slice(0, MAX_KEPT)
    this.index.clear()
    for (const entry of files) this.index.set(entry.token, entry)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ version: 1, files } satisfies Kept), 'utf8')
    } catch {
      // A list that cannot be written still works for this run: the cards in front of the person do not depend on it.
    }
  }
}

/** A path as a person or a model wrote it: in quotes, with a trailing space. A "~" stays as it is, so it is refused. */
export function cleanPath(raw: string): string {
  let path = raw.trim()
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1).trim()
  else if (path.length >= 2 && path.startsWith("'") && path.endsWith("'")) path = path.slice(1, -1).trim()
  return path
}
