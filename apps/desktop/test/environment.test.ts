import { describe, expect, it } from 'vitest'

import {
  createEnvironment,
  firstVersion,
  resolveCommand,
  resolvePython,
  scanEnvironment,
  type CommandDeps,
  type EnvironmentFs,
  type ExecFn,
} from '../src/main/runtime/environment'

interface Entry {
  size?: number
  dir?: boolean
  exec?: boolean
}

/** A path map that behaves like the file system the scan needs, on any host. */
function fakeFs(entries: Record<string, Entry>, caseInsensitive = false): EnvironmentFs {
  const originals = Object.keys(entries)
  const lookup = new Map<string, Entry>()
  originals.forEach((path) => lookup.set(caseInsensitive ? path.toLowerCase() : path, entries[path] ?? {}))
  const key = (path: string): string => (caseInsensitive ? path.toLowerCase() : path)
  const entry = (path: string): Entry | undefined => lookup.get(key(path))

  return {
    exists: (path) => entry(path) !== undefined,
    isDirectory: (path) => entry(path)?.dir === true,
    size: (path) => entry(path)?.size ?? 0,
    isExecutable: (path) => entry(path)?.exec !== false,
    list: (folder) => {
      const prefix = folder.endsWith('\\') ? folder : `${folder}\\`
      return originals
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('\\'))
        .map((path) => path.slice(prefix.length))
    },
  }
}

function windowsDeps(files: Record<string, Entry>, env: NodeJS.ProcessEnv = {}): CommandDeps {
  return {
    platform: 'win32',
    env: {
      PATH: 'C:\\Tools;C:\\Windows\\System32',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      ...env,
    },
    fs: fakeFs(files, true),
  }
}

interface Recorded {
  file: string
  args: string[]
  timeoutMs: number
}

function recordingExec(
  versions: Record<string, string> = {},
  options: { delayMs?: number; reject?: Set<string> } = {},
): { exec: ExecFn; calls: Recorded[]; peak: () => number } {
  const calls: Recorded[] = []
  let active = 0
  let peak = 0
  const exec: ExecFn = async (file, args, runOptions) => {
    calls.push({ file, args, timeoutMs: runOptions.timeoutMs })
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 5))
    active -= 1
    if (options.reject?.has(file)) throw new Error('timed out')
    const name = file.replace(/\\/g, '/').split('/').pop() ?? file
    const stem = name.replace(/\.[^.]+$/, '')
    const stdout = versions[file] ?? versions[name] ?? versions[stem] ?? ''
    return { stdout }
  }
  return { exec, calls, peak: () => peak }
}

function scanDeps(files: Record<string, Entry>, exec: ExecFn, env: NodeJS.ProcessEnv = {}) {
  return {
    ...windowsDeps(files, env),
    release: '10.0.22631',
    arch: 'x64',
    hostname: 'TESTER-PC',
    exec,
    now: () => 1_700_000_000_000,
  }
}

describe('resolveCommand', () => {
  it('tries PATHEXT in the order the machine gives', () => {
    const deps = windowsDeps({
      'C:\\Tools\\tool.COM': { size: 10 },
      'C:\\Tools\\tool.EXE': { size: 10 },
    })
    expect(resolveCommand('tool', deps)?.path).toBe('C:\\Tools\\tool.COM')
  })

  it('honours a custom PATHEXT order', () => {
    const deps = windowsDeps(
      { 'C:\\Tools\\tool.EXE': { size: 10 }, 'C:\\Tools\\tool.CMD': { size: 10 } },
      { PATHEXT: '.CMD;.EXE' },
    )
    expect(resolveCommand('tool', deps)?.path).toBe('C:\\Tools\\tool.CMD')
  })

  it('finds a .ps1 shim even when PATHEXT leaves it out', () => {
    const deps = windowsDeps({ 'C:\\Tools\\claude.PS1': { size: 100 } }, { PATHEXT: '.EXE' })
    const found = resolveCommand('claude', deps)
    expect(found?.path).toBe('C:\\Tools\\claude.PS1')
    expect(found?.kind).toBe('ps1')
  })

  it('skips a directory with the right name', () => {
    const deps = windowsDeps({ 'C:\\Tools\\node.EXE': { dir: true } })
    expect(resolveCommand('node', deps)).toBeNull()
  })

  it('skips a zero-byte Windows Store alias', () => {
    const deps = windowsDeps({
      'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\python.EXE': { size: 0 },
    })
    expect(resolveCommand('python', deps)).toBeNull()
  })

  it('keeps a real program inside WindowsApps', () => {
    const deps = windowsDeps(
      { 'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\python3.EXE': { size: 4096 } },
      { PATH: 'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps' },
    )
    expect(resolveCommand('python3', deps)?.path).toContain('WindowsApps')
  })

  it('ignores case on Windows', () => {
    const deps = windowsDeps({ 'C:\\Tools\\Git.EXE': { size: 10 } })
    expect(resolveCommand('git', deps)?.path).toBe('C:\\Tools\\Git.EXE')
  })

  it('names the kind from the extension', () => {
    const deps = windowsDeps({
      'C:\\Tools\\a.cmd': { size: 1 },
      'C:\\Tools\\b.ps1': { size: 1 },
      'C:\\Tools\\c.exe': { size: 1 },
    })
    expect(resolveCommand('a', deps)?.kind).toBe('cmd')
    expect(resolveCommand('b', deps)?.kind).toBe('ps1')
    expect(resolveCommand('c', deps)?.kind).toBe('exe')
  })

  it('checks the executable bit on Linux', () => {
    const files = { '/usr/bin/tool': { size: 1, exec: false } }
    const deps: CommandDeps = {
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      fs: fakeFs(files),
    }
    expect(resolveCommand('tool', deps)).toBeNull()
    const executable: CommandDeps = { ...deps, fs: fakeFs({ '/usr/bin/tool': { size: 1, exec: true } }) }
    expect(resolveCommand('tool', executable)?.kind).toBe('script')
  })

  it('returns null when the name is nowhere', () => {
    expect(resolveCommand('nothing', windowsDeps({}))).toBeNull()
  })

  it('checks an absolute path directly', () => {
    const deps = windowsDeps({ 'C:\\Tools\\tool.EXE': { size: 10 } })
    expect(resolveCommand('C:\\Tools\\tool.EXE', deps)?.path).toBe('C:\\Tools\\tool.EXE')
  })
})

describe('version parsing', () => {
  it('reads the first version-looking token', () => {
    expect(firstVersion('Python 3.12.4')).toBe('3.12.4')
    expect(firstVersion('git version 2.43.0.windows.1')).toBe('2.43.0')
    expect(firstVersion('v20.11.1')).toBe('20.11.1')
    expect(firstVersion('no numbers here')).toBeUndefined()
  })
})

describe('scanEnvironment', () => {
  it('reports the Windows shells in order without pretending pwsh exists', async () => {
    const { exec } = recordingExec()
    const report = await scanEnvironment(
      scanDeps(
        {
          'C:\\Windows\\System32\\powershell.EXE': { size: 10 },
          'C:\\Windows\\System32\\cmd.EXE': { size: 10 },
        },
        exec,
      ),
    )
    expect(report.shells.map((row) => row.id)).toEqual(['pwsh', 'powershell', 'cmd'])
    expect(report.shells.map((row) => row.found)).toEqual([false, true, true])
  })

  it('uses py -3 for Python when the launcher is there', async () => {
    const run = recordingExec({ py: 'Python 3.12.4' })
    const report = await scanEnvironment(
      scanDeps(
        {
          'C:\\Tools\\py.EXE': { size: 10 },
          'C:\\Windows\\System32\\powershell.EXE': { size: 10 },
        },
        run.exec,
      ),
    )
    const python = report.runtimes.find((row) => row.id === 'python')
    expect(python?.found).toBe(true)
    expect(python?.version).toBe('3.12.4')
    expect(run.calls.some((call) => call.file.endsWith('py.EXE') && call.args.join(' ') === '-3 --version')).toBe(true)
  })

  it('finds AI tools in their usual install folders, built from env vars only', async () => {
    const run = recordingExec({ 'claude.cmd': '1.0.60' })
    const report = await scanEnvironment(
      scanDeps(
        {
          'C:\\Users\\tester\\AppData\\Roaming\\npm\\claude.cmd': { size: 10 },
          'C:\\Program Files\\nodejs\\node.EXE': { size: 10 },
          'C:\\Windows\\System32\\powershell.EXE': { size: 10 },
        },
        run.exec,
        {
          LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
          APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
          USERPROFILE: 'C:\\Users\\tester',
        },
      ),
    )
    const claude = report.aiTools.find((row) => row.id === 'claude')
    expect(claude?.found).toBe(true)
    expect(claude?.version).toBe('1.0.60')
    expect(report.aiTools.find((row) => row.id === 'gemini')?.found).toBe(false)
  })

  it('runs nothing but --version, with the four second timeout', async () => {
    const run = recordingExec()
    await scanEnvironment(
      scanDeps(
        {
          'C:\\Windows\\System32\\powershell.EXE': { size: 10 },
          'C:\\Program Files\\nodejs\\node.EXE': { size: 10 },
        },
        run.exec,
      ),
    )
    expect(run.calls.length).toBeGreaterThan(0)
    for (const call of run.calls) {
      expect(call.timeoutMs).toBe(4_000)
      expect(call.args[call.args.length - 1]).toBe('--version')
      expect(call.args.length).toBeLessThanOrEqual(2)
    }
  })

  it('asks versions in parallel', async () => {
    const run = recordingExec({}, { delayMs: 20 })
    await scanEnvironment(
      scanDeps(
        {
          'C:\\Windows\\System32\\powershell.EXE': { size: 10 },
          'C:\\Windows\\System32\\cmd.EXE': { size: 10 },
          'C:\\Program Files\\nodejs\\node.EXE': { size: 10 },
          'C:\\Program Files\\Git\\cmd\\git.EXE': { size: 10 },
        },
        run.exec,
      ),
    )
    expect(run.peak()).toBeGreaterThan(1)
  })

  it('marks a tool that hangs as found, with no version', async () => {
    const run = recordingExec({}, { reject: new Set(['C:\\Windows\\System32\\powershell.EXE']) })
    const report = await scanEnvironment(
      scanDeps({ 'C:\\Windows\\System32\\powershell.EXE': { size: 10 } }, run.exec),
    )
    const powershell = report.shells.find((row) => row.id === 'powershell')
    expect(powershell?.found).toBe(true)
    expect(powershell?.version).toBeUndefined()
  })

  it('says plainly when nothing is found', async () => {
    const report = await scanEnvironment(scanDeps({}, recordingExec().exec))
    expect(report.shells.every((row) => !row.found)).toBe(true)
    expect(report.runtimes.every((row) => !row.found)).toBe(true)
    expect(report.aiTools.every((row) => !row.found)).toBe(true)
  })

  it('reports WSL as a note on Windows and never as a shell', async () => {
    const report = await scanEnvironment(
      scanDeps({ 'C:\\Windows\\System32\\wsl.EXE': { size: 10 } }, recordingExec().exec),
    )
    expect(report.notes.join(' ')).toContain('Windows Subsystem for Linux')
    expect(report.shells.map((row) => row.id)).not.toContain('wsl')
  })

  it('does not mention WSL on other systems', async () => {
    const deps = {
      platform: 'linux' as const,
      env: { PATH: '/usr/bin' },
      fs: fakeFs({ '/usr/bin/wsl': { size: 1 } }),
      release: '6.8.0',
      arch: 'x64',
      hostname: 'test',
      exec: recordingExec().exec,
      now: () => 1,
    }
    const report = await scanEnvironment(deps)
    expect(report.notes.join(' ')).not.toContain('Windows Subsystem')
  })

  it('reports Linux shells', async () => {
    const deps = {
      platform: 'linux' as NodeJS.Platform,
      env: { PATH: '/usr/bin' },
      fs: fakeFs({ '/usr/bin/bash': { size: 1 }, '/usr/bin/sh': { size: 1 } }),
      release: '6.8.0',
      arch: 'x64',
      hostname: 'test',
      exec: recordingExec().exec,
      now: () => 1,
    }
    const report = await scanEnvironment(deps)
    expect(report.shells.map((row) => row.id)).toEqual(['bash', 'zsh', 'sh'])
    expect(report.shells.find((row) => row.id === 'bash')?.found).toBe(true)
  })

  it('resolves Python in the documented order', () => {
    const found = resolvePython(windowsDeps({ 'C:\\Tools\\python.EXE': { size: 10 } }))
    expect(found?.path).toBe('C:\\Tools\\python.EXE')
    expect(found?.prefix).toEqual([])
  })
})

describe('createEnvironment', () => {
  it('caches for the session and rescans when asked', async () => {
    const run = recordingExec()
    const environment = createEnvironment(
      scanDeps(
        {
          'C:\\Windows\\System32\\powershell.EXE': { size: 10 },
          'C:\\Program Files\\nodejs\\node.EXE': { size: 10 },
        },
        run.exec,
      ),
    )
    const first = await environment.scan()
    const calls = run.calls.length
    const second = await environment.scan()
    expect(second).toBe(first)
    expect(run.calls.length).toBe(calls)
    expect(environment.current()).toBe(first)

    await environment.scan({ refresh: true })
    expect(run.calls.length).toBeGreaterThan(calls)
  })

  it('shares one run between concurrent callers', async () => {
    const run = recordingExec({}, { delayMs: 20 })
    const environment = createEnvironment(
      scanDeps({ 'C:\\Program Files\\nodejs\\node.EXE': { size: 10 } }, run.exec),
    )
    const [a, b] = await Promise.all([environment.scan(), environment.scan()])
    expect(a).toBe(b)
  })
})
