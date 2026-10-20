/**
 * Path rules, including the Windows ones that only bite on a real machine (M12).
 *
 * Windows quietly ignores trailing dots and spaces, reserves device names, allows alternate data
 * streams and accepts `\\?\` prefixes. Each of those can make a path that looks safe land somewhere
 * else, so a path is canonicalised and checked before the granted-folder decision is made.
 */
import { posix, win32 } from 'node:path'

export interface PathApi {
  resolve(...paths: string[]): string
  join(...paths: string[]): string
  dirname(path: string): string
  basename(path: string): string
  normalize(path: string): string
  isAbsolute(path: string): boolean
  readonly sep: string
}

export function pathsFor(platform: NodeJS.Platform): PathApi {
  return platform === 'win32' ? win32 : posix
}

const RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
])

export type WindowsPathResult = { ok: true; path: string } | { ok: false; error: string }

/** The name Windows actually uses: everything before the first dot, upper-cased. */
function baseName(segment: string): string {
  const dot = segment.indexOf('.')
  return (dot < 0 ? segment : segment.slice(0, dot)).toUpperCase()
}

function stripExtendedPrefix(path: string): string | null {
  if (!path.startsWith('\\\\?\\')) return path
  const rest = path.slice(4)
  if (rest.toUpperCase().startsWith('UNC\\')) return `\\\\${rest.slice(4)}` // \\?\UNC\server\share
  if (/^[A-Za-z]:/.test(rest)) return rest
  return null
}

/**
 * Turn a raw path into the one Windows would really touch, or explain plainly why it will not be
 * touched. Rejects device paths, alternate data streams and reserved names; folds mixed slashes and
 * trailing dots/spaces. Short (8.3) names and junctions are left to `realpath` later.
 */
export function canonicalWindowsPath(input: string): WindowsPathResult {
  if (input.includes('\u0000')) return { ok: false, error: 'That path contains an invalid character.' }

  let path = input.trim().replace(/\//g, '\\')
  if (path.startsWith('\\\\.\\')) {
    return { ok: false, error: 'Device paths are not supported. Pick a normal file or folder.' }
  }
  const stripped = stripExtendedPrefix(path)
  if (stripped === null) {
    return { ok: false, error: 'That kind of Windows path is not supported. Pick a normal file or folder.' }
  }
  path = stripped

  const driveMatch = path.match(/^([A-Za-z]:)(.*)$/)
  const afterDrive = driveMatch === null ? path : (driveMatch[2] ?? '')
  if (afterDrive.includes(':')) {
    return {
      ok: false,
      error: 'Alternate data streams (the part after a colon) are not supported. Pick a normal file.',
    }
  }

  const unc = path.startsWith('\\\\')
  const prefix = driveMatch !== null ? driveMatch[1] : unc ? '\\\\' : ''
  const body = driveMatch !== null ? afterDrive.replace(/^\\/, '') : unc ? path.slice(2) : path
  if (driveMatch !== null && body === '') {
    return { ok: true, path: `${driveMatch[1]}\\` }
  }
  const segments = body.split('\\').filter((segment, index) => segment !== '' || index === 0)
  const cleaned: string[] = []

  for (const segment of segments) {
    if (segment === '') continue
    if (segment === '.' || segment === '..') {
      cleaned.push(segment)
      continue
    }
    const trimmed = segment.replace(/[. ]+$/, '')
    if (trimmed === '') {
      return { ok: false, error: 'Windows ignores dots and spaces at the end of a name, so that path is not safe.' }
    }
    if (RESERVED.has(baseName(trimmed))) {
      return { ok: false, error: `${trimmed} is a reserved name on Windows, so I cannot use it.` }
    }
    cleaned.push(trimmed)
  }

  if (cleaned.length === 0) {
    return { ok: false, error: 'That path does not name a file or folder.' }
  }

  if (prefix === '\\\\') return { ok: true, path: `\\\\${cleaned.join('\\')}` }
  if (prefix !== '') return { ok: true, path: `${prefix}\\${cleaned.join('\\')}` }
  return { ok: true, path: cleaned.join('\\') }
}

/**
 * True when two paths name the same place. Windows ignores case for the whole path; POSIX does not.
 */
export function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const api = pathsFor(platform)
  const a = api.resolve(left)
  const b = api.resolve(right)
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
