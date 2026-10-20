import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fileTools, insideFolder } from '../src/main/tools/files'
import { settingsView, testContext, toolNamed } from './support'

let root = ''
let granted = ''
let outside = ''
let picks: Set<string>

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-files-')))
  granted = join(root, 'granted')
  outside = join(root, 'elsewhere')
  mkdirSync(granted)
  mkdirSync(outside)
  writeFileSync(join(granted, 'notes.txt'), 'the sky is blue')
  writeFileSync(join(outside, 'secret.txt'), 'not yours')
  picks = new Set()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function tools(approve: () => Promise<boolean>, extra: { pickFiles?: () => Promise<string[]> } = {}) {
  return fileTools({
    settings: settingsView({ grantedFolders: [granted] }),
    picks,
    home: () => root,
    platform: 'linux',
    ...extra,
  })
}

describe('files tools: reading', () => {
  it('reads and lists inside a granted folder without asking', async () => {
    const approve = vi.fn(async () => false)
    const list = toolNamed(tools(approve), 'files_list')
    const read = toolNamed(tools(approve), 'files_read')

    const listing = await list.run({ path: granted }, testContext())
    expect(listing).toContain('notes.txt')

    const text = await read.run({ path: join(granted, 'notes.txt') }, testContext())
    expect(text).toContain('the sky is blue')
    expect(approve).not.toHaveBeenCalled()
  })

  it('asks before reading an absolute path outside the granted folders', async () => {
    const denied = vi.fn(async () => false)
    const result = await toolNamed(tools(denied), 'files_read').run(
      { path: join(outside, 'secret.txt') },
      testContext({ approve: denied }),
    )

    expect(result).toContain('did not approve')
    expect(result).not.toContain('not yours')
    expect(denied).toHaveBeenCalledOnce()
  })

  it('does not let ".." walk out of a granted folder', async () => {
    const approve = vi.fn(async () => false)
    const escaping = join(granted, '..', 'elsewhere', 'secret.txt')
    const result = await toolNamed(tools(approve), 'files_read').run(
      { path: escaping },
      testContext({ approve }),
    )

    expect(result).not.toContain('not yours')
    expect(approve).toHaveBeenCalledOnce()
    const summary = approve.mock.calls[0]?.[0]
    expect(summary).toContain('secret.txt')
  })

  it('does not follow a symlink out of a granted folder', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(granted, 'looks-inside.txt'))
    const approve = vi.fn(async () => false)
    const result = await toolNamed(tools(approve), 'files_read').run(
      { path: join(granted, 'looks-inside.txt') },
      testContext({ approve }),
    )

    expect(result).not.toContain('not yours')
    expect(approve).toHaveBeenCalledOnce()
  })

  it('reads a file the person picked without asking again', async () => {
    picks.add(realpathSync(join(outside, 'secret.txt')))
    const approve = vi.fn(async () => false)
    const result = await toolNamed(tools(approve), 'files_read').run(
      { path: join(outside, 'secret.txt') },
      testContext({ approve }),
    )

    expect(result).toContain('not yours')
    expect(approve).not.toHaveBeenCalled()
  })

  it('cuts a long file at maxChars and says so', async () => {
    writeFileSync(join(granted, 'long.txt'), 'x'.repeat(5_000))
    const result = await toolNamed(tools(async () => false), 'files_read').run(
      { path: join(granted, 'long.txt'), maxChars: 300 },
      testContext(),
    )

    expect(result).toContain('x'.repeat(300))
    expect(result).not.toContain('x'.repeat(301))
    expect(result).toContain('cut')
  })

  it('hands an image back as a marker the model can look at', async () => {
    const image = join(granted, 'photo.png')
    writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const result = await toolNamed(tools(async () => false), 'files_read').run(
      { path: image },
      testContext(),
    )
    expect(result).toContain(`[[image:${image}]]`)
  })

  it('says plainly when a file is not there', async () => {
    const result = await toolNamed(tools(async () => false), 'files_read').run(
      { path: join(granted, 'missing.txt') },
      testContext(),
    )
    expect(result).toContain('There is no file or folder')
  })
})

describe('files tools: writing and moving', () => {
  it('writes inside a granted folder without asking', async () => {
    const approve = vi.fn(async () => false)
    const result = await toolNamed(tools(approve), 'files_write').run(
      { path: join(granted, 'new', 'note.md'), content: 'hello' },
      testContext({ approve }),
    )

    expect(result).toContain('Wrote 5 characters')
    expect(readFileSync(join(granted, 'new', 'note.md'), 'utf8')).toBe('hello')
    expect(approve).not.toHaveBeenCalled()
  })

  it('will not write outside a granted folder without approval', async () => {
    const approve = vi.fn(async () => false)
    const target = join(outside, 'new.txt')
    const result = await toolNamed(tools(approve), 'files_write').run(
      { path: target, content: 'nope' },
      testContext({ approve }),
    )

    expect(result).toContain('did not approve')
    expect(() => readFileSync(target)).toThrow()
    expect(approve).toHaveBeenCalledOnce()
  })

  it('writes outside a granted folder once the person approves', async () => {
    const approve = vi.fn(async () => true)
    const target = join(outside, 'allowed.txt')
    await toolNamed(tools(approve), 'files_write').run(
      { path: target, content: 'yes' },
      testContext({ approve }),
    )
    expect(readFileSync(target, 'utf8')).toBe('yes')
  })

  it('moves a file inside a granted folder', async () => {
    const result = await toolNamed(tools(async () => false), 'files_move').run(
      { from: join(granted, 'notes.txt'), to: join(granted, 'kept', 'notes.md') },
      testContext(),
    )

    expect(result).toContain('Moved')
    expect(readFileSync(join(granted, 'kept', 'notes.md'), 'utf8')).toBe('the sky is blue')
  })
})

describe('files tools: finding and picking', () => {
  it('finds by pattern below a granted folder', async () => {
    mkdirSync(join(granted, 'reports'))
    writeFileSync(join(granted, 'reports', 'march.csv'), 'a,b')
    writeFileSync(join(granted, 'reports', 'april.txt'), 'c')

    const result = await toolNamed(tools(async () => false), 'files_find').run(
      { root: granted, pattern: '*.csv' },
      testContext(),
    )
    expect(result).toContain('march.csv')
    expect(result).not.toContain('april.txt')
  })

  it('adds picked files to the allowed set for the session', async () => {
    const picked = join(outside, 'secret.txt')
    const approve = vi.fn(async () => false)
    const pickedRun = await toolNamed(
      tools(approve, { pickFiles: async () => [picked] }),
      'files_pick',
    ).run({ reason: 'a statement' }, testContext({ approve }))

    expect(pickedRun).toContain(picked)
    expect(picks.has(realpathSync(picked))).toBe(true)

    const text = await toolNamed(tools(approve), 'files_read').run(
      { path: picked },
      testContext({ approve }),
    )
    expect(text).toContain('not yours')
    expect(approve).not.toHaveBeenCalled()
  })

  it('says so when nothing was picked', async () => {
    const result = await toolNamed(
      tools(async () => false, { pickFiles: async () => [] }),
      'files_pick',
    ).run({}, testContext())
    expect(result).toContain('did not pick')
  })
})

describe('insideFolder', () => {
  it('is case-sensitive on Linux and case-insensitive on Windows', () => {
    expect(insideFolder('/home/sam/Docs/file.txt', '/home/sam/Docs', 'linux')).toBe(true)
    expect(insideFolder('/home/sam/docs/file.txt', '/home/sam/Docs', 'linux')).toBe(false)

    expect(insideFolder('C:\\Users\\Me\\Docs\\file.txt', 'c:\\users\\me\\docs', 'win32')).toBe(true)
    expect(insideFolder('C:\\Users\\Me\\Docs\\file.txt', 'C:\\Users\\Me\\Documents', 'win32')).toBe(false)
    expect(insideFolder('C:\\Users\\Me\\Docs-secret\\x.txt', 'C:\\Users\\Me\\Docs', 'win32')).toBe(false)
  })

  it('resolves dot segments before deciding', () => {
    expect(insideFolder('/home/sam/Docs/../etc/passwd', '/home/sam/Docs', 'linux')).toBe(false)
    expect(insideFolder('/home/sam/Docs/./a/b', '/home/sam/Docs', 'linux')).toBe(true)
    expect(insideFolder('C:\\Users\\Me\\Docs\\..\\Other\\x', 'C:\\Users\\Me\\Docs', 'win32')).toBe(false)
  })
})
