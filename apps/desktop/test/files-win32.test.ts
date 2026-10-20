import { win32 } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { canonicalWindowsPath, pathsFor } from '../src/main/runtime/paths'
import {
  fileTools,
  insideFolder,
  type DirEntryLike,
  type FileHandleLike,
  type FileSystemLike,
  type StatsLike,
} from '../src/main/tools/files'
import { settingsView, testContext, toolNamed } from './support'

const HOME = 'C:\\Users\\tester'
const DOCS = 'C:\\Users\\tester\\docs'

interface VFile {
  content?: string
  dir?: boolean
}

/** A case-insensitive Windows-shaped file system that lives in a Map. */
function virtualWindowsFs(initial: Record<string, VFile>): {
  fs: FileSystemLike
  files: Map<string, VFile>
} {
  const files = new Map<string, { path: string; file: VFile }>()
  for (const [path, file] of Object.entries(initial)) {
    files.set(path.toLowerCase(), { path: win32.resolve(path), file })
  }
  const key = (path: string): string => win32.resolve(path).toLowerCase()
  const lookup = (path: string): { path: string; file: VFile } | undefined => files.get(key(path))
  const require = (path: string): { path: string; file: VFile } => {
    const found = lookup(path)
    if (found === undefined) throw new Error(`ENOENT: ${path}`)
    return found
  }

  const fs: FileSystemLike = {
    async realpath(path) {
      return require(path).path
    },
    async stat(path): Promise<StatsLike> {
      const found = require(path)
      return {
        size: found.file.content?.length ?? 0,
        isDirectory: () => found.file.dir === true,
      }
    },
    async readdir(path): Promise<DirEntryLike[]> {
      const found = require(path)
      if (found.file.dir !== true) throw new Error('ENOTDIR')
      const prefix = `${found.path}\\`.toLowerCase()
      const seen = new Set<string>()
      const entries: DirEntryLike[] = []
      for (const [lower, child] of files) {
        if (!lower.startsWith(prefix)) continue
        const rest = child.path.slice(found.path.length + 1)
        if (rest.includes('\\')) continue
        if (seen.has(rest.toLowerCase())) continue
        seen.add(rest.toLowerCase())
        entries.push({ name: rest, isDirectory: () => child.file.dir === true, isSymbolicLink: () => false })
      }
      return entries
    },
    async writeFile(path, data) {
      files.set(key(path), { path: win32.resolve(path), file: { content: data } })
    },
    async mkdir() {
      return undefined
    },
    async rename(from, to) {
      const found = require(from)
      files.delete(key(from))
      files.set(key(to), { path: win32.resolve(to), file: found.file })
    },
    async cp(from, to) {
      const found = require(from)
      files.set(key(to), { path: win32.resolve(to), file: { ...found.file } })
    },
    async rm(path) {
      files.delete(key(path))
    },
    async open(path): Promise<FileHandleLike> {
      const found = require(path)
      const content = Buffer.from(found.file.content ?? '', 'utf8')
      return {
        async read(buffer, offset, length, position) {
          const slice = content.subarray(position, position + length)
          slice.copy(buffer, offset)
          return { bytesRead: slice.length }
        },
        async close() {
          return undefined
        },
      }
    },
  }
  return { fs, files }
}

function baseFiles(): Record<string, VFile> {
  return {
    'C:\\Users\\tester': { dir: true },
    [DOCS]: { dir: true },
    [`${DOCS}\\notes.txt`]: { content: 'the sky is blue' },
    'C:\\Users\\tester\\elsewhere': { dir: true },
    'C:\\Users\\tester\\elsewhere\\secret.txt': { content: 'not yours' },
  }
}

function tools(approve: () => Promise<boolean>, files: Record<string, VFile> = baseFiles()) {
  const virtual = virtualWindowsFs(files)
  return {
    virtual,
    list: toolNamed(
      fileTools({
        settings: settingsView({ grantedFolders: [DOCS] }),
        home: () => HOME,
        platform: 'win32',
        paths: win32,
        fs: virtual.fs,
      }),
      'files_list',
    ),
    read: toolNamed(
      fileTools({
        settings: settingsView({ grantedFolders: [DOCS] }),
        home: () => HOME,
        platform: 'win32',
        paths: win32,
        fs: virtual.fs,
      }),
      'files_read',
    ),
    write: toolNamed(
      fileTools({
        settings: settingsView({ grantedFolders: [DOCS] }),
        home: () => HOME,
        platform: 'win32',
        paths: win32,
        fs: virtual.fs,
      }),
      'files_write',
    ),
    approve,
  }
}

describe('Windows path canonicalisation', () => {
  it('accepts mixed slashes and a drive letter', () => {
    expect(canonicalWindowsPath('C:/Users/tester/notes.txt')).toEqual({
      ok: true,
      path: 'C:\\Users\\tester\\notes.txt',
    })
  })

  it('strips trailing dots and spaces, which Windows ignores', () => {
    expect(canonicalWindowsPath('C:\\Users\\tester\\notes.txt.  ')).toEqual({
      ok: true,
      path: 'C:\\Users\\tester\\notes.txt',
    })
  })

  it('rejects reserved device names', () => {
    expect(canonicalWindowsPath('C:\\Users\\tester\\CON').ok).toBe(false)
    expect(canonicalWindowsPath('C:\\Users\\tester\\COM1.txt').ok).toBe(false)
    expect(canonicalWindowsPath('C:\\Users\\tester\\LPT9').ok).toBe(false)
  })

  it('rejects alternate data streams', () => {
    const checked = canonicalWindowsPath('C:\\Users\\tester\\notes.txt:hidden')
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.error).toContain('Alternate data streams')
  })

  it('rejects raw device paths', () => {
    expect(canonicalWindowsPath('\\\\.\\PhysicalDrive0').ok).toBe(false)
  })

  it('accepts an extended-length drive path', () => {
    expect(canonicalWindowsPath('\\\\?\\C:\\Users\\tester\\notes.txt')).toEqual({
      ok: true,
      path: 'C:\\Users\\tester\\notes.txt',
    })
  })

  it('accepts an extended-length UNC path', () => {
    expect(canonicalWindowsPath('\\\\?\\UNC\\server\\share\\file.txt')).toEqual({
      ok: true,
      path: '\\\\server\\share\\file.txt',
    })
  })

  it('accepts a normal UNC path', () => {
    expect(canonicalWindowsPath('\\\\server\\share\\folder')).toEqual({
      ok: true,
      path: '\\\\server\\share\\folder',
    })
  })

  it('accepts a drive root', () => {
    expect(canonicalWindowsPath('C:\\')).toEqual({ ok: true, path: 'C:\\' })
  })
})

describe('Windows folder comparisons', () => {
  it('ignores case for the whole path', () => {
    expect(insideFolder('c:\\users\\TESTER\\docs\\a.txt', DOCS, 'win32')).toBe(true)
  })

  it('does not mistake a longer sibling name for a child', () => {
    expect(insideFolder('C:\\Users\\tester\\docs2\\a.txt', DOCS, 'win32')).toBe(false)
  })

  it('stays case-sensitive elsewhere', () => {
    expect(insideFolder('/home/tester/Docs/a', '/home/tester/docs', 'linux')).toBe(false)
  })

  it('uses the Windows separator from the injected path layer', () => {
    expect(pathsFor('win32').join('C:\\Users\\tester', 'docs', 'a.txt')).toBe('C:\\Users\\tester\\docs\\a.txt')
  })
})

describe('files tools on a Windows-shaped file system', () => {
  it('writes inside a granted folder without asking', async () => {
    const approve = vi.fn(async () => false)
    const harness = tools(approve)
    const result = await harness.write.run(
      { path: 'C:\\Users\\tester\\docs\\new.txt', content: 'hello' },
      testContext(),
    )
    expect(result).toContain('Wrote 5 characters')
    expect(approve).not.toHaveBeenCalled()
    expect(harness.virtual.files.get('c:\\users\\tester\\docs\\new.txt')?.file.content).toBe('hello')
  })

  it('refuses a reserved name and writes nothing', async () => {
    const approve = vi.fn(async () => true)
    const harness = tools(approve)
    const result = await harness.write.run(
      { path: 'C:\\Users\\tester\\docs\\NUL.txt', content: 'x' },
      testContext(),
    )
    expect(result).toContain('reserved name')
    expect(approve).not.toHaveBeenCalled()
    expect(harness.virtual.files.has('c:\\users\\tester\\docs\\nul.txt')).toBe(false)
  })

  it('asks before reading outside the granted folders, then reads', async () => {
    const approve = vi.fn(async () => true)
    const harness = tools(approve)
    const result = await harness.read.run(
      { path: 'C:\\Users\\tester\\elsewhere\\secret.txt' },
      testContext({ approve }),
    )
    expect(approve).toHaveBeenCalledOnce()
    expect(result).toContain('not yours')
  })

  it('lists a granted folder', async () => {
    const harness = tools(async () => false)
    const result = await harness.list.run({ path: DOCS }, testContext())
    expect(result).toContain('notes.txt')
  })

  it('preserves CRLF exactly as it was given', async () => {
    const harness = tools(async () => false)
    const content = 'one\r\ntwo\r\n'
    await harness.write.run({ path: 'C:\\Users\\tester\\docs\\crlf.txt', content }, testContext())
    expect(harness.virtual.files.get('c:\\users\\tester\\docs\\crlf.txt')?.file.content).toBe(content)
  })

  it('reports a plain error when the folder is not there', async () => {
    const harness = tools(async () => false)
    const result = await harness.list.run({ path: 'C:\\Users\\tester\\missing' }, testContext())
    expect(result).toContain('There is no file or folder at')
  })
})
