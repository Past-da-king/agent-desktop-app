/**
 * Tools that touch files on this computer (PLAN.md 5.3 and 7).
 *
 * The rule everywhere: a path is resolved and made real first, and it may only be touched without
 * asking when it sits inside a folder the person granted or a file they picked in this session.
 * Anything else needs `ctx.approve`. Resolving symlinks before the check is what stops a link inside
 * a granted folder from reaching the rest of the disk.
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path'

import { int, schema, str, type Settings, type Tool } from '@agent/core'

export const DEFAULT_READ_CHARS = 30_000
export const MAX_READ_CHARS = 200_000
export const MAX_WRITE_CHARS = 1_000_000
const MAX_LIST_ENTRIES = 500
const MAX_FIND_RESULTS = 200
const MAX_FIND_VISITS = 3_000
const MAX_FIND_DEPTH = 10
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])

export interface FileSettingsView {
  get(): Settings
}

export interface FileToolDeps {
  settings: FileSettingsView
  /** Files and folders the person picked this session; they are allowed without another ask. */
  picks?: Set<string>
  /** Opens the OS picker and returns the chosen absolute paths. */
  pickFiles?: () => Promise<string[]>
  /** Tests pin the home folder and the path rules; production uses the real ones. */
  home?: () => string
  platform?: NodeJS.Platform
}

export function fileTools(deps: FileToolDeps): Tool[] {
  return [listTool(deps), readTool(deps), writeTool(deps), findTool(deps), pickTool(deps), moveTool(deps)]
}

// ---- path rules ---------------------------------------------------------------------------

/** True when `child` is `folder` itself or sits below it. Case-insensitive on Windows only. */
export function insideFolder(
  child: string,
  folder: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const api = platform === 'win32' ? win32 : posix
  const inside = api.resolve(folder)
  const target = api.resolve(child)
  if (platform === 'win32') {
    const a = inside.toLowerCase()
    const b = target.toLowerCase()
    return b === a || b.startsWith(a.endsWith('\\') ? a : `${a}\\`)
  }
  return target === inside || target.startsWith(inside === '/' ? '/' : `${inside}/`)
}

/**
 * The real path a write would land on. If the file (or part of its parent chain) does not exist
 * yet, the nearest existing ancestor is made real and the rest is appended unchanged, so a symlink
 * higher up cannot be used to slip out of a granted folder.
 */
export async function realPathForWrite(path: string): Promise<string> {
  const absolute = resolve(path)
  try {
    return await fs.realpath(absolute)
  } catch {
    const parent = dirname(absolute)
    if (parent === absolute) return absolute
    return join(await realPathForWrite(parent), basename(absolute))
  }
}

export function expandHome(path: string, home = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

function absoluteFrom(raw: string, home: string): string {
  const expanded = expandHome(raw.trim(), home)
  return isAbsolute(expanded) ? expanded : resolve(home, expanded)
}

interface Allowed {
  path: string
}

interface Denied {
  error: string
}

async function grantedFolders(deps: FileToolDeps): Promise<string[]> {
  const home = deps.home?.() ?? homedir()
  const folders: string[] = []
  for (const folder of deps.settings.get().grantedFolders) {
    const absolute = absoluteFrom(folder, home)
    try {
      folders.push(await fs.realpath(absolute))
    } catch {
      // A granted folder that has been moved or deleted grants nothing.
    }
  }
  return folders
}

function isPicked(path: string, picks: Set<string> | undefined, platform: NodeJS.Platform): boolean {
  if (picks === undefined) return false
  for (const pick of picks) {
    if (insideFolder(path, pick, platform)) return true
  }
  return false
}

/**
 * Resolve a path for one operation, asking permission when it is outside everything granted.
 * `verb` is how the approval card puts it to the person.
 */
async function accessPath(
  deps: FileToolDeps,
  ctx: Parameters<Tool['run']>[1],
  raw: string,
  mode: 'read' | 'write',
): Promise<Allowed | Denied> {
  const clean = raw.trim()
  if (clean === '') return { error: 'Pass a full path to the file or folder.' }
  const home = deps.home?.() ?? homedir()
  const platform = deps.platform ?? process.platform
  const absolute = absoluteFrom(clean, home)

  let target: string
  try {
    target = mode === 'read' ? await fs.realpath(absolute) : await realPathForWrite(absolute)
  } catch {
    return { error: `There is no file or folder at ${absolute}.` }
  }

  const granted = await grantedFolders(deps)
  const allowed =
    granted.some((folder) => insideFolder(target, folder, platform)) ||
    isPicked(target, deps.picks, platform)
  if (allowed) return { path: target }

  const verb = mode === 'read' ? 'Read' : 'Write to'
  const approved = await ctx.approve(
    `${verb} ${target}`,
    `${mode === 'read' ? 'This file is outside' : 'This file is outside'} the folders you have granted. Allow the agent to ${mode === 'read' ? 'read' : 'write'} it this once?`,
  )
  if (!approved) return { error: `You did not approve access to ${target}, so I left it alone.` }
  return { path: target }
}

// ---- tools --------------------------------------------------------------------------------

function listTool(deps: FileToolDeps): Tool {
  return {
    spec: {
      name: 'files_list',
      description:
        'List what is in a folder on this computer: names, whether each is a folder or file, and sizes.',
      schema: schema(['path'], {
        path: str('Folder path, for example ~/Documents or an absolute path'),
      }),
    },
    run: async (input, ctx) => {
      const access = await accessPath(deps, ctx, text(input['path']), 'read')
      if ('error' in access) return access.error

      const info = await fs.stat(access.path).catch(() => null)
      if (info === null) return `There is no folder at ${access.path}.`
      if (!info.isDirectory()) return `${access.path} is a file. Use files_read to read it.`

      const entries = await fs.readdir(access.path, { withFileTypes: true }).catch(() => [])
      if (entries.length === 0) return `${access.path} is empty.`

      const rows = entries
        .slice()
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        .slice(0, MAX_LIST_ENTRIES)
      const lines: string[] = []
      for (const entry of rows) {
        if (entry.isDirectory()) {
          lines.push(`folder  ${entry.name}/`)
        } else if (entry.isSymbolicLink()) {
          lines.push(`link    ${entry.name}`)
        } else {
          const size = await fs.stat(join(access.path, entry.name)).then(
            (stat) => stat.size,
            () => 0,
          )
          lines.push(`file    ${entry.name}  (${size} bytes)`)
        }
      }
      if (entries.length > rows.length) lines.push(`...(${entries.length - rows.length} more not shown)`)
      return `${access.path}\n${lines.join('\n')}`
    },
  }
}

function readTool(deps: FileToolDeps): Tool {
  return {
    spec: {
      name: 'files_read',
      description:
        'Read a text file on this computer, or hand an image to yourself to look at. Long files are cut at maxChars.',
      schema: schema(['path'], {
        path: str('File path'),
        maxChars: int('How much text to read, default 30000'),
      }),
    },
    run: async (input, ctx) => {
      const access = await accessPath(deps, ctx, text(input['path']), 'read')
      if ('error' in access) return access.error

      const info = await fs.stat(access.path).catch(() => null)
      if (info === null) return `There is no file at ${access.path}.`
      if (info.isDirectory()) return `${access.path} is a folder. Use files_list to look inside it.`

      if (IMAGE_EXTENSIONS.has(extensionOf(access.path))) {
        return `## ${basename(access.path)} (${kilobytes(info.size)} KB)\n[[image:${access.path}]]`
      }

      const limit = clamp(number(input['maxChars'], DEFAULT_READ_CHARS), 200, MAX_READ_CHARS)
      const buffer = await readPrefix(access.path, Math.min(info.size, limit * 4 + 4))
      if (buffer.includes(0)) {
        return `${basename(access.path)} is a binary file (${kilobytes(info.size)} KB), so I cannot read it as text.`
      }

      const content = buffer.toString('utf8')
      const cut = content.length > limit || info.size > buffer.length
      const body = content.slice(0, limit)
      return `## ${basename(access.path)} (${kilobytes(info.size)} KB)\n${body}${
        cut ? `\n...(cut, ${info.size} bytes in all)` : ''
      }`
    },
  }
}

function writeTool(deps: FileToolDeps): Tool {
  return {
    spec: {
      name: 'files_write',
      description:
        'Write a text file on this computer. Inside a folder you granted it happens straight away; anywhere else it asks first.',
      schema: schema(['path', 'content'], {
        path: str('Where to write'),
        content: str('The full text to write'),
      }),
    },
    run: async (input, ctx) => {
      const content = text(input['content'])
      if (content.length > MAX_WRITE_CHARS) {
        return `That is too much for one file (${content.length} characters). Keep it under ${MAX_WRITE_CHARS}.`
      }
      const access = await accessPath(deps, ctx, text(input['path']), 'write')
      if ('error' in access) return access.error

      try {
        await fs.mkdir(dirname(access.path), { recursive: true })
        await fs.writeFile(access.path, content, 'utf8')
      } catch (error) {
        return `Could not write ${access.path}: ${messageOf(error)}`
      }
      return `Wrote ${content.length} characters to ${access.path}.`
    },
  }
}

function findTool(deps: FileToolDeps): Tool {
  return {
    spec: {
      name: 'files_find',
      description:
        'Find files by name under a folder. The pattern may use * and ?, for example *.pdf or report-*.docx.',
      schema: schema(['root', 'pattern'], {
        root: str('Folder to search in'),
        pattern: str('Name pattern, for example *.csv'),
      }),
    },
    run: async (input, ctx) => {
      const access = await accessPath(deps, ctx, text(input['root']), 'read')
      if ('error' in access) return access.error

      const info = await fs.stat(access.path).catch(() => null)
      if (info === null || !info.isDirectory()) return `${access.path} is not a folder.`

      const pattern = text(input['pattern']).trim() || '*'
      const platform = deps.platform ?? process.platform
      const match = nameMatcher(pattern, platform === 'win32')
      const found = await walkForMatches(access.path, match)
      if (found.length === 0) return `Nothing under ${access.path} matches ${pattern}.`
      const shown = found.slice(0, MAX_FIND_RESULTS)
      const tail =
        found.length > shown.length ? `\n...(${found.length - shown.length} more not shown)` : ''
      return shown.join('\n') + tail
    },
  }
}

function pickTool(deps: FileToolDeps): Tool {
  return {
    spec: {
      name: 'files_pick',
      description:
        'Ask the person to choose one or more files from this computer with the system file picker. You only ever see what they choose.',
      schema: schema([], {
        reason: str('What you need, for example a bank statement'),
      }),
    },
    run: async (input) => {
      if (deps.pickFiles === undefined) return 'Picking files is not available here.'
      const paths = await deps.pickFiles()
      if (paths.length === 0) return 'The user did not pick any files.'
      for (const path of paths) {
        try {
          deps.picks?.add(await fs.realpath(path))
        } catch {
          // A path that vanished between choosing and reading is simply not granted.
        }
      }
      const why = text(input['reason']).trim()
      const head = why === '' ? 'The user picked these files:' : `The user picked these files (${why}):`
      return `${head}\n${paths.map((path) => `- ${path}`).join('\n')}`
    },
  }
}

function moveTool(deps: FileToolDeps): Tool {
  return {
    spec: {
      name: 'files_move',
      description: 'Move or rename a file or folder on this computer.',
      schema: schema(['from', 'to'], {
        from: str('The file or folder to move'),
        to: str('Where it should go, including its new name'),
      }),
    },
    run: async (input, ctx) => {
      const from = await accessPath(deps, ctx, text(input['from']), 'read')
      if ('error' in from) return from.error
      const to = await accessPath(deps, ctx, text(input['to']), 'write')
      if ('error' in to) return to.error

      try {
        await fs.mkdir(dirname(to.path), { recursive: true })
        try {
          await fs.rename(from.path, to.path)
        } catch (error) {
          if (codeOf(error) !== 'EXDEV') throw error
          await fs.cp(from.path, to.path, { recursive: true })
          await fs.rm(from.path, { recursive: true, force: true })
        }
      } catch (error) {
        return `Could not move ${from.path}: ${messageOf(error)}`
      }
      return `Moved ${from.path} to ${to.path}.`
    },
  }
}

// ---- small helpers -------------------------------------------------------------------------

async function readPrefix(path: string, bytes: number): Promise<Buffer> {
  const handle = await fs.open(path, 'r')
  try {
    const buffer = Buffer.alloc(Math.max(0, bytes))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function walkForMatches(root: string, match: (name: string) => boolean): Promise<string[]> {
  const results: string[] = []
  const queue: Array<{ folder: string; depth: number }> = [{ folder: root, depth: 0 }]
  let visited = 0

  while (queue.length > 0 && visited < MAX_FIND_VISITS) {
    const next = queue.shift()
    if (next === undefined) break
    let entries
    try {
      entries = await fs.readdir(next.folder, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      visited++
      if (visited > MAX_FIND_VISITS) break
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const full = join(next.folder, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (next.depth < MAX_FIND_DEPTH) queue.push({ folder: full, depth: next.depth + 1 })
        continue
      }
      if (match(entry.name)) results.push(full)
      if (results.length >= MAX_FIND_RESULTS * 4) return results
    }
  }
  return results
}

function nameMatcher(pattern: string, caseInsensitive: boolean): (name: string) => boolean {
  const source = pattern.includes('*') || pattern.includes('?') ? pattern : `*${pattern}*`
  const escaped = source.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  const expression = new RegExp(`^${escaped}$`, caseInsensitive ? 'i' : '')
  return (name) => expression.test(name)
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? '' : path.slice(dot + 1).toLowerCase()
}

function kilobytes(bytes: number): number {
  return Math.max(0, Math.round(bytes / 1024))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function codeOf(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
