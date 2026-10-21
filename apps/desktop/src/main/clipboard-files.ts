/**
 * Files copied in Explorer, Finder or a Linux file manager, read from the system clipboard by the main process.
 *
 * A paste event in the window usually carries File objects for them, but not always (older Chromium, some
 * copy sources), so the composer asks here when a paste brought no files and no text. Per platform:
 *  - Windows: CF_HDROP (a DROPFILES header and a double-NUL-ended list of paths) when Electron can read it,
 *    else FileNameW (the first path, UTF-16), and then PowerShell's FileDropList for the full list;
 *  - macOS: NSFilenamesPboardType (a plist of paths), else public.file-url;
 *  - Linux: x-special/gnome-copied-files or text/uri-list (file:// addresses).
 */
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mimeForFile, type Attachment } from '@agent/core'

/** Electron 44's clipboard: read() gives items whose types include raw OS formats. */
export interface ClipboardItemLike {
  types: string[]
  getType(type: string): Promise<unknown>
}

export interface ClipboardLike {
  read(): Promise<ClipboardItemLike[]>
}

const RAW = /^electron application\/osclipboard;format="(.*)"$/

/** The format a clipboard type names: the OS format inside Electron's raw wrapper, or the MIME type itself. */
export function formatName(type: string): string {
  return RAW.exec(type)?.[1] ?? type
}

async function bytesOf(value: unknown): Promise<Buffer> {
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (value !== null && typeof value === 'object' && 'arrayBuffer' in value && typeof value.arrayBuffer === 'function') {
    const data: unknown = await (value as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer()
    return data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.alloc(0)
  }
  return Buffer.alloc(0)
}

/** Every format on the clipboard that may name files, by format name, as bytes. */
export async function fileFormats(clipboard: ClipboardLike): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>()
  let items: ClipboardItemLike[] = []
  try {
    items = await clipboard.read()
  } catch {
    return out
  }
  for (const item of items) {
    for (const type of item.types) {
      const name = formatName(type)
      if (!/hdrop|filename|uri-list|gnome-copied-files|file-url|NSFilenamesPboardType|^15$/i.test(name)) continue
      if (out.has(name)) continue
      try {
        out.set(name, await bytesOf(await item.getType(type)))
      } catch {
        // A format that vanished between listing and reading: skip it.
      }
    }
  }
  return out
}

/**
 * The paths in a CF_HDROP block (DROPFILES: pFiles DWORD, pt POINT, fNC BOOL, fWide BOOL, then the list), or
 * in a bare list (FileNameW is one UTF-16 path, NUL-ended). Wide or ANSI, as the header says.
 */
export function parseDropFiles(buf: Buffer): string[] {
  if (buf.length === 0) return []
  if (buf.length >= 20) {
    const offset = buf.readUInt32LE(0)
    const wide = buf.readUInt32LE(16)
    if (offset === 20 && offset < buf.length && (wide === 0 || wide === 1)) {
      return splitPaths(buf.subarray(offset), wide === 1)
    }
  }
  // No header: FileNameW (UTF-16) is the common case; a lone ANSI FileName has no zero high bytes.
  const looksWide = buf.length >= 4 && buf[1] === 0 && buf.length % 2 === 0
  return splitPaths(buf, looksWide)
}

function splitPaths(list: Buffer, wide: boolean): string[] {
  const text = wide ? list.toString('utf16le', 0, list.length - (list.length % 2)) : list.toString('latin1')
  const paths: string[] = []
  for (const part of text.split('\u0000')) {
    if (part === '') {
      if (paths.length > 0) break
      continue
    }
    paths.push(part)
  }
  return paths.filter((path) => /^([A-Za-z]:[\\/]|\\\\|\/)/.test(path))
}

/** Paths from file:// lines (text/uri-list, gnome-copied-files). Comments and the "copy"/"cut" verb are skipped. */
export function parseFileUris(text: string): string[] {
  const paths: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\u0000/g, '').trim()
    if (!line.startsWith('file://')) continue
    try {
      paths.push(fileURLToPath(line))
    } catch {
      // A malformed address names no file we can attach.
    }
  }
  return paths
}

/** Paths in the plist macOS writes for NSFilenamesPboardType. */
export function parsePlistPaths(xml: string): string[] {
  return [...xml.matchAll(/<string>([^<]+)<\/string>/g)].map((match) =>
    (match[1] ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
  )
}

/** Windows: every path PowerShell sees in the clipboard's file drop list. */
export function powerShellFileList(timeoutMs = 6000): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }',
      ],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          resolve([])
          return
        }
        resolve(
          stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line !== ''),
        )
      },
    )
  })
}

function pick(formats: Map<string, Buffer>, pattern: RegExp): Buffer | null {
  for (const [name, bytes] of formats) if (pattern.test(name)) return bytes
  return null
}

/** Absolute paths of the files on the clipboard, in order, without repeats. */
export async function clipboardFilePaths(
  clipboard: ClipboardLike,
  platform: NodeJS.Platform = process.platform,
  listAll: () => Promise<string[]> = powerShellFileList,
): Promise<string[]> {
  const unique = (paths: string[]): string[] => [...new Set(paths)]
  const formats = await fileFormats(clipboard)
  const uris = pick(formats, /uri-list|gnome-copied-files|file-url/i)
  if (platform === 'win32') {
    const hdrop = pick(formats, /hdrop|^15$/i)
    const fromDrop = hdrop === null ? [] : parseDropFiles(hdrop)
    if (fromDrop.length > 0) return unique(fromDrop)
    const fromUris = uris === null ? [] : parseFileUris(uris.toString('utf8'))
    if (fromUris.length > 0) return unique(fromUris)
    const nameW = pick(formats, /^FileNameW$/i) ?? pick(formats, /^FileName$/i)
    const first = nameW === null ? [] : parseDropFiles(nameW)
    // FileNameW only ever names the first file (and Electron may not list CF_HDROP at all): ask Windows for
    // the whole drop list. This is the last resort, so it only runs when the paste brought nothing else.
    const all = await listAll()
    return unique(all.length > 0 ? all : first)
  }
  if (platform === 'darwin') {
    const plist = pick(formats, /NSFilenamesPboardType/i)
    const fromPlist = plist === null ? [] : parsePlistPaths(plist.toString('utf8'))
    if (fromPlist.length > 0) return unique(fromPlist)
  }
  return unique(uris === null ? [] : parseFileUris(uris.toString('utf8')))
}

/** The clipboard's files as attachments: only ones that exist, with their size. */
export async function clipboardAttachments(
  clipboard: ClipboardLike,
  platform: NodeJS.Platform = process.platform,
  listAll?: () => Promise<string[]>,
): Promise<Attachment[]> {
  const paths = await clipboardFilePaths(clipboard, platform, listAll)
  const out: Attachment[] = []
  for (const path of paths.slice(0, 20)) {
    if (!existsSync(path)) continue
    try {
      const info = statSync(path)
      out.push({
        path,
        name: basename(path) || path,
        mime: info.isDirectory() ? 'inode/directory' : mimeForFile(path),
        ...(info.isDirectory() ? {} : { size: info.size }),
      })
    } catch {
      // Gone between the copy and the paste.
    }
  }
  return out
}
