import { describe, expect, it } from 'vitest'

import type { ResolvedCommand } from '../src/main/runtime/environment'
import {
  chooseShell,
  sanitiseEnv,
  treeKillCommand,
  utf8Cmd,
  utf8PowerShell,
} from '../src/main/tools/shell'

function resolver(found: Record<string, string>): (name: string) => ResolvedCommand | null {
  return (name) => {
    const path = found[name]
    return path === undefined ? null : { path, kind: path.endsWith('.ps1') ? 'ps1' : 'exe' }
  }
}

describe('chooseShell on Windows', () => {
  it('prefers PowerShell 7 when it is there', () => {
    const plan = chooseShell({
      platform: 'win32',
      env: {},
      command: 'echo hi',
      resolve: resolver({ pwsh: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }),
    })
    expect('error' in plan).toBe(false)
    if ('error' in plan) return
    expect(plan.id).toBe('pwsh')
    expect(plan.args).toContain('-NoProfile')
    expect(plan.args).toContain('-NonInteractive')
  })

  it('falls back to Windows PowerShell 5.1 with the documented flags', () => {
    const plan = chooseShell({
      platform: 'win32',
      env: {},
      command: 'echo hi',
      resolve: resolver({ powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }),
    })
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.id).toBe('powershell')
    expect(plan.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
    ])
  })

  it('falls back to cmd when no PowerShell exists', () => {
    const plan = chooseShell({ platform: 'win32', env: {}, command: 'echo hi', resolve: resolver({}) })
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.id).toBe('cmd')
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
  })

  it('lets the agent ask for cmd when it was found', () => {
    const plan = chooseShell({
      platform: 'win32',
      env: {},
      command: 'dir',
      resolve: resolver({ cmd: 'C:\\Windows\\System32\\cmd.exe' }),
      requested: 'cmd',
    })
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.id).toBe('cmd')
    expect(plan.file).toBe('C:\\Windows\\System32\\cmd.exe')
  })

  it('refuses PowerShell when it is not installed', () => {
    const plan = chooseShell({ platform: 'win32', env: {}, command: 'dir', resolve: resolver({ cmd: 'x' }), requested: 'powershell' })
    expect('error' in plan && plan.error).toContain('not on this computer')
  })

  it('refuses bash when it is not installed', () => {
    const plan = chooseShell({ platform: 'win32', env: {}, command: 'ls', resolve: resolver({}), requested: 'bash' })
    expect('error' in plan && plan.error).toContain('Bash is not on this computer')
  })

  it('uses Git Bash only when it is really there', () => {
    const plan = chooseShell({
      platform: 'win32',
      env: {},
      command: 'ls',
      resolve: resolver({ bash: 'C:\\Program Files\\Git\\bin\\bash.exe' }),
      requested: 'bash',
    })
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.id).toBe('bash')
    expect(plan.args).toEqual(['-c', 'ls'])
  })
})

describe('UTF-8 wrappers', () => {
  it('sets both PowerShell encodings before the command', () => {
    const wrapped = utf8PowerShell('Get-ChildItem')
    expect(wrapped).toContain('[Console]::OutputEncoding')
    expect(wrapped).toContain('$OutputEncoding')
    expect(wrapped.endsWith('Get-ChildItem')).toBe(true)
    expect(wrapped.indexOf('[Console]')).toBeLessThan(wrapped.indexOf('Get-ChildItem'))
  })

  it('switches cmd to code page 65001 first', () => {
    expect(utf8Cmd('dir')).toMatch(/^chcp 65001 >nul & dir$/)
  })
})

describe('chooseShell elsewhere', () => {
  it("uses the person's $SHELL when it exists", () => {
    const plan = chooseShell({
      platform: 'linux',
      env: { SHELL: '/usr/bin/zsh' },
      command: 'ls',
      exists: (path) => path === '/usr/bin/zsh',
    })
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.id).toBe('zsh')
    expect(plan.file).toBe('/usr/bin/zsh')
    expect(plan.args).toEqual(['-c', 'ls'])
  })

  it('falls back to sh when $SHELL is missing', () => {
    const plan = chooseShell({ platform: 'darwin', env: {}, command: 'ls' })
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.id).toBe('sh')
    expect(plan.file).toBe('sh')
  })

  it('does not offer PowerShell on Linux', () => {
    const plan = chooseShell({ platform: 'linux', env: {}, command: 'ls', requested: 'powershell' })
    expect('error' in plan).toBe(true)
  })
})

describe('process care', () => {
  it('kills the whole tree with taskkill on Windows', () => {
    expect(treeKillCommand(4321, 'win32')).toEqual({
      file: 'taskkill',
      args: ['/PID', '4321', '/T', '/F'],
    })
  })

  it('uses the process group on POSIX instead', () => {
    expect(treeKillCommand(4321, 'linux')).toBeNull()
  })

  it('strips secret-looking names whatever their case', () => {
    const clean = sanitiseEnv({
      Path: 'C:\\Windows',
      api_key: 'a',
      Api_Key: 'b',
      GITHUB_TOKEN: 'c',
      my_secret: 'd',
      DB_PASSWORD: 'e',
      ELECTRON_RUN_AS_NODE: '1',
      KEEP_ME: 'yes',
    })
    expect(clean['Path']).toBe('C:\\Windows')
    expect(clean['KEEP_ME']).toBe('yes')
    expect(clean['api_key']).toBeUndefined()
    expect(clean['Api_Key']).toBeUndefined()
    expect(clean['GITHUB_TOKEN']).toBeUndefined()
    expect(clean['my_secret']).toBeUndefined()
    expect(clean['DB_PASSWORD']).toBeUndefined()
    expect(clean['ELECTRON_RUN_AS_NODE']).toBeUndefined()
  })
})
