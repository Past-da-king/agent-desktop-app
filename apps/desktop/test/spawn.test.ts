import type { ChildProcess } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnvironmentFs } from '../src/main/runtime/environment'
import {
  cmdInvocation,
  powershellInvocation,
  quoteCmdArgument,
  spawnResolved,
} from '../src/main/runtime/spawn'

let folder = ''

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'agent-spawn-'))
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

function fakeFs(paths: string[]): EnvironmentFs {
  const set = new Set(paths.map((path) => path.toLowerCase()))
  return {
    exists: (path) => set.has(path.toLowerCase()),
    isDirectory: () => false,
    size: () => 100,
    isExecutable: () => true,
  }
}

interface Captured {
  file: string
  args: string[]
  options: Record<string, unknown>
}

function captureSpawn(): { spawnImpl: typeof import('node:child_process').spawn; calls: Captured[] } {
  const calls: Captured[] = []
  const spawnImpl = ((file: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ file, args, options })
    return {} as ChildProcess
  }) as unknown as typeof import('node:child_process').spawn
  return { spawnImpl, calls }
}

describe('cmd quoting', () => {
  const table: Array<[string, string]> = [
    ['plain', '"plain"'],
    ['two words', '"two words"'],
    ['a&b', '"a&b"'],
    ['a|b', '"a|b"'],
    ['100% done', '"100%% done"'],
    ['caret^here', '"caret^here"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['C:\\temp\\', String.raw`"C:\temp\\"`],
    ['(x)', '"(x)"'],
  ]

  it.each(table)('keeps %s intact for cmd', (input, expected) => {
    expect(quoteCmdArgument(input)).toBe(expected)
  })

  it('protects the program path too', () => {
    expect(quoteCmdArgument('C:\\Program Files\\tool.cmd')).toBe(String.raw`"C:\Program Files\tool.cmd"`)
  })

  it('wraps the whole line the way cmd /s expects', () => {
    const invocation = cmdInvocation('C:\\Tools\\a.cmd', ['one two', '50%'], { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })
    expect(invocation.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(invocation.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(invocation.args[3]).toBe(String.raw`""C:\Tools\a.cmd" "one two" "50%%""`)
  })
})

describe('powershell invocation', () => {
  it('uses -NoProfile -ExecutionPolicy Bypass -File', () => {
    const invocation = powershellInvocation('C:\\Tools\\a.ps1', ['two words'])
    expect(invocation.file).toBe('powershell.exe')
    expect(invocation.args).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\Tools\\a.ps1', 'two words'])
  })
})

describe('spawnResolved on Windows', () => {
  it('sends a .cmd through cmd.exe /d /s /c, never directly', () => {
    const { spawnImpl, calls } = captureSpawn()
    spawnResolved('tool', ['two words', 'a&b'], {
      platform: 'win32',
      spawnImpl,
      cmdExe: 'C:\\Windows\\System32\\cmd.exe',
      env: { PATH: 'C:\\Tools', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      resolve: {
        platform: 'win32',
        env: { PATH: 'C:\\Tools', PATHEXT: '.CMD' },
        fs: fakeFs(['C:\\Tools\\tool.cmd']),
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(calls[0]?.args[0]).toBe('/d')
    expect(calls[0]?.args[1]).toBe('/s')
    expect(calls[0]?.args[2]).toBe('/c')
    expect(calls[0]?.options['windowsVerbatimArguments']).toBe(true)
    expect(calls[0]?.args[3]).toContain('two words')
  })

  it('runs a .exe directly with shell false and untouched arguments', () => {
    const { spawnImpl, calls } = captureSpawn()
    spawnResolved('tool', ['two words', '50%'], {
      platform: 'win32',
      spawnImpl,
      resolve: {
        platform: 'win32',
        env: { PATH: 'C:\\Tools', PATHEXT: '.EXE' },
        fs: fakeFs(['C:\\Tools\\tool.exe']),
      },
    })
    expect(calls[0]?.file).toBe('C:\\Tools\\tool.EXE')
    expect(calls[0]?.args).toEqual(['two words', '50%'])
    expect(calls[0]?.options['shell']).toBe(false)
  })

  it('sends a .ps1 through Windows PowerShell', () => {
    const { spawnImpl, calls } = captureSpawn()
    spawnResolved('tool', ['a&b'], {
      platform: 'win32',
      spawnImpl,
      resolve: {
        platform: 'win32',
        env: { PATH: 'C:\\Tools', PATHEXT: '.PS1' },
        fs: fakeFs(['C:\\Tools\\tool.ps1']),
      },
    })
    expect(calls[0]?.file).toBe('powershell.exe')
    expect(calls[0]?.args).toContain('-File')
    expect(calls[0]?.args).toContain('C:\\Tools\\tool.PS1')
    expect(calls[0]?.args).toContain('a&b')
  })

  it('refuses a script Windows cannot start directly', () => {
    expect(() =>
      spawnResolved('C:\\Tools\\thing.sh', [], {
        platform: 'win32',
        spawnImpl: captureSpawn().spawnImpl,
      }),
    ).toThrow(/not a program Windows can start/)
  })
})

describe('spawnResolved with a real program', () => {
  it('refuses a name that is not installed', () => {
    expect(() => spawnResolved('definitely-not-here', [], { spawnImpl: captureSpawn().spawnImpl })).toThrow(
      /Could not find/,
    )
  })

  it('starts a .exe and returns its output', async () => {
    const script = join(folder, 'args.mjs')
    writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)))')
    const output = await collect(spawnResolved(process.execPath, [script, 'two words', 'a&b', '100% added'], {
      platform: process.platform,
    }))
    expect(JSON.parse(output)).toEqual(['two words', 'a&b', '100% added'])
  })

  it('starts an executable script directly on POSIX', async () => {
    if (process.platform === 'win32') return
    const script = join(folder, 'echo.sh')
    writeFileSync(script, '#!/bin/sh\nprintf "%s|" "$@"\n')
    chmodSync(script, 0o755)
    const output = await collect(spawnResolved(script, ['two words', 'a&b', '100% added'], { platform: 'linux' }))
    expect(output).toBe('two words|a&b|100% added|')
  })

  it('checks the executable bit when resolving through a fake file system', () => {
    const spawnImpl = vi.fn(() => ({}) as ChildProcess) as unknown as typeof import('node:child_process').spawn
    const fs: EnvironmentFs = {
      exists: (path) => path === '/opt/tool',
      isDirectory: () => false,
      isExecutable: () => true,
    }
    spawnResolved('tool', [], {
      platform: 'linux',
      spawnImpl,
      resolve: { platform: 'linux', env: { PATH: '/opt' }, fs },
    })
    expect(spawnImpl).toHaveBeenCalledOnce()
  })
})

function collect(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('close', () => resolve(text.trim()))
  })
}
