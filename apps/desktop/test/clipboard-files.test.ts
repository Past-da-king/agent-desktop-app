/**
 * Files copied in a file manager, read off the system clipboard. The CF_HDROP buffers here are built byte for
 * byte the way Explorer writes them: a 20-byte DROPFILES header (pFiles = 20, pt.x, pt.y, fNC, fWide) followed by
 * NUL-separated paths and a final extra NUL.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import {
  clipboardAttachments,
  clipboardFilePaths,
  formatName,
  parseDropFiles,
  parseFileUris,
  parsePlistPaths,
  type ClipboardLike,
} from '../src/main/clipboard-files'
import { safeFileName, savePastedFile } from '../src/main/pasted'

const dir = mkdtempSync(join(tmpdir(), 'agent-clip-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** DROPFILES + path list, exactly as Explorer puts CF_HDROP on the clipboard. */
function hdrop(paths: string[], wide = true): Buffer {
  const header = Buffer.alloc(20)
  header.writeUInt32LE(20, 0) // pFiles: the list starts right after the header
  header.writeInt32LE(0, 4) // pt.x
  header.writeInt32LE(0, 8) // pt.y
  header.writeUInt32LE(0, 12) // fNC
  header.writeUInt32LE(wide ? 1 : 0, 16) // fWide
  const list = paths.map((path) => `${path}\u0000`).join('') + '\u0000'
  return Buffer.concat([header, Buffer.from(list, wide ? 'utf16le' : 'latin1')])
}

/** Electron 44's clipboard: read() gives items; raw OS formats are named in the osclipboard wrapper. */
function clipboard(formats: Record<string, Buffer | string>): ClipboardLike {
  const types = Object.keys(formats)
  return {
    read: async () => [
      {
        types,
        getType: async (type: string) => {
          const value = formats[type]
          if (value === undefined) throw new Error('not there')
          const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
          return new Blob([new Uint8Array(bytes)])
        },
      },
    ],
  }
}

const raw = (name: string): string => `electron application/osclipboard;format="${name}"`

describe('parsing CF_HDROP and FileNameW', () => {
  it('reads every path from a wide DROPFILES block', () => {
    const paths = ['C:\\Users\\Ayanda\\Desktop\\Quarterly report.pdf', 'C:\\Users\\Ayanda\\Pictures\\screen shot.png', 'D:\\Work\\données.xlsx']
    expect(parseDropFiles(hdrop(paths))).toEqual(paths)
  })

  it('reads an ANSI DROPFILES block', () => {
    expect(parseDropFiles(hdrop(['C:\\temp\\a.txt', 'C:\\temp\\b.zip'], false))).toEqual(['C:\\temp\\a.txt', 'C:\\temp\\b.zip'])
  })

  it('reads network paths and stops at the double NUL', () => {
    const buf = Buffer.concat([hdrop(['\\\\server\\share\\plan.docx']), Buffer.from('garbage after the end', 'utf16le')])
    expect(parseDropFiles(buf)).toEqual(['\\\\server\\share\\plan.docx'])
  })

  it('reads a bare FileNameW (one UTF-16 path) and ignores junk', () => {
    expect(parseDropFiles(Buffer.from('C:\\Users\\Ayanda\\notes.txt\u0000', 'utf16le'))).toEqual(['C:\\Users\\Ayanda\\notes.txt'])
    expect(parseDropFiles(Buffer.alloc(0))).toEqual([])
    expect(parseDropFiles(Buffer.from('not a path\u0000', 'utf16le'))).toEqual([])
  })

  it('names Electron raw formats', () => {
    expect(formatName(raw('FileNameW'))).toBe('FileNameW')
    expect(formatName('text/uri-list')).toBe('text/uri-list')
  })
})

describe('file URIs and plists', () => {
  it('reads text/uri-list and gnome-copied-files', () => {
    expect(parseFileUris('# comment\r\nfile:///home/a/report%20final.pdf\r\nfile:///home/a/x.png\r\n')).toEqual([
      '/home/a/report final.pdf',
      '/home/a/x.png',
    ])
    expect(parseFileUris('copy\nfile:///home/a/b.txt\u0000')).toEqual(['/home/a/b.txt'])
    expect(parseFileUris('https://example.com/not-a-file')).toEqual([])
  })

  it('reads the NSFilenamesPboardType plist', () => {
    const xml = '<?xml version="1.0"?><plist version="1.0"><array><string>/Users/a/Q3 &amp; Q4.xlsx</string><string>/Users/a/b.pdf</string></array></plist>'
    expect(parsePlistPaths(xml)).toEqual(['/Users/a/Q3 & Q4.xlsx', '/Users/a/b.pdf'])
  })
})

describe('reading the clipboard per platform', () => {
  it('Windows: a CF_HDROP format gives every file and PowerShell is not needed', async () => {
    let asked = 0
    const listAll = async (): Promise<string[]> => {
      asked += 1
      return []
    }
    const paths = await clipboardFilePaths(clipboard({ [raw('CF_HDROP')]: hdrop(['C:\\a.pdf', 'C:\\b.docx']), 'text/plain': '' }), 'win32', listAll)
    expect(paths).toEqual(['C:\\a.pdf', 'C:\\b.docx'])
    expect(asked).toBe(0)
  })

  it('Windows: only FileNameW listed, so the full drop list is asked for', async () => {
    const paths = await clipboardFilePaths(
      clipboard({ [raw('FileNameW')]: Buffer.from('C:\\first.png\u0000', 'utf16le'), [raw('Shell IDList Array')]: Buffer.alloc(8) }),
      'win32',
      async () => ['C:\\first.png', 'C:\\second.pdf', 'C:\\third.zip'],
    )
    expect(paths).toEqual(['C:\\first.png', 'C:\\second.pdf', 'C:\\third.zip'])
  })

  it('Windows: when PowerShell gives nothing, the one FileNameW path still attaches', async () => {
    const paths = await clipboardFilePaths(clipboard({ [raw('FileNameW')]: Buffer.from('C:\\only.txt\u0000', 'utf16le') }), 'win32', async () => [])
    expect(paths).toEqual(['C:\\only.txt'])
  })

  it('macOS and Linux read their own formats', async () => {
    const mac = clipboard({ [raw('NSFilenamesPboardType')]: '<plist><array><string>/Users/a/x.pdf</string></array></plist>' })
    expect(await clipboardFilePaths(mac, 'darwin')).toEqual(['/Users/a/x.pdf'])
    const gnome = clipboard({ [raw('x-special/gnome-copied-files')]: 'copy\nfile:///home/a/y.txt\nfile:///home/a/y.txt' })
    expect(await clipboardFilePaths(gnome, 'linux')).toEqual(['/home/a/y.txt'])
    expect(await clipboardFilePaths(clipboard({ 'text/uri-list': 'file:///tmp/z.png' }), 'linux')).toEqual(['/tmp/z.png'])
  })

  it('a clipboard that cannot be read gives nothing', async () => {
    const broken: ClipboardLike = { read: async () => Promise.reject(new Error('busy')) }
    expect(await clipboardFilePaths(broken, 'linux')).toEqual([])
  })

  it('turns the paths into attachments: real files with sizes, folders marked, missing ones dropped', async () => {
    const report = join(dir, 'report.pdf')
    writeFileSync(report, Buffer.alloc(1234))
    const folder = join(dir, 'photos')
    mkdirSync(folder)
    const uris = [report, folder, join(dir, 'gone.txt')].map((path) => pathToFileURL(path).href).join('\n')
    const found = await clipboardAttachments(clipboard({ 'text/uri-list': uris }), 'linux')
    expect(found).toEqual([
      { path: report, name: 'report.pdf', mime: 'application/pdf', size: 1234 },
      { path: folder, name: 'photos', mime: 'inode/directory' },
    ])
  })
})

describe('saving something pasted', () => {
  it('makes a safe name that keeps or adds its extension', () => {
    expect(safeFileName('a/b:c*?.png', 'image/png')).toBe('a-b-c--.png')
    expect(safeFileName('', 'image/png')).toBe('Pasted image.png')
    expect(safeFileName('notes', 'text/plain')).toBe('notes.txt')
    expect(safeFileName('..hidden', 'application/octet-stream')).toBe('hidden')
  })

  it('writes under a day folder without overwriting, and refuses what is too big', () => {
    const now = new Date(2026, 9, 21, 4, 0, 0)
    const first = savePastedFile(dir, 'shot.png', 'image/png', new Uint8Array([1, 2, 3]), now)
    const second = savePastedFile(dir, 'shot.png', 'image/png', new Uint8Array([4]), now)
    expect(first.path).toBe(join(dir, '2026-10-21', 'shot.png'))
    expect(second.path).toBe(join(dir, '2026-10-21', 'shot (2).png'))
    expect(first).toMatchObject({ name: 'shot.png', mime: 'image/png', size: 3 })
    expect(() => savePastedFile(dir, 'huge.bin', 'application/octet-stream', new Uint8Array(21 * 1024 * 1024), now)).toThrow('too big')
  })
})
