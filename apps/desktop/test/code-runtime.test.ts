import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ProgramRef } from '../src/main/runtime/environment'
import { codeTools, resolveCodeProgram } from '../src/main/tools/code'
import { testContext, toolNamed } from './support'

let folder = ''

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'agent-code-runtime-'))
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

const nodeProgram: ProgramRef = { path: 'C:\\Program Files\\nodejs\\node.exe', prefix: [], kind: 'exe' }
const pythonProgram: ProgramRef = { path: 'C:\\Python\\py.exe', prefix: ['-3'], kind: 'exe' }

function environment(node: ProgramRef | null, python: ProgramRef | null) {
  return { node: () => node, python: () => python }
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    pid: number
    exitCode: number
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 1234
  child.exitCode = 0
  setImmediate(() => {
    child.stdout.emit('data', Buffer.from('ran\n'))
    child.emit('close', 0)
  })
  return child as unknown as ChildProcess
}

describe('choosing the runtime', () => {
  it("uses the person's Node when the scan found it", () => {
    const choice = resolveCodeProgram('javascript', { environment: environment(nodeProgram, null) })
    expect(choice.program?.path).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(choice.appRuntime).toBe(false)
  })

  it("falls back to the app's own runtime when there is no Node", () => {
    const choice = resolveCodeProgram('javascript', {
      environment: environment(null, null),
      execPath: '/opt/agent/agent',
    })
    expect(choice.program?.path).toBe('/opt/agent/agent')
    expect(choice.appRuntime).toBe(true)
  })

  it('uses the Python launcher from the scan, with -3', () => {
    const choice = resolveCodeProgram('python', { environment: environment(null, pythonProgram) })
    expect(choice.program?.path).toBe('C:\\Python\\py.exe')
    expect(choice.program?.prefix).toEqual(['-3'])
    expect(choice.appRuntime).toBe(false)
  })

  it('has no Python program when the scan found none', () => {
    const choice = resolveCodeProgram('python', { environment: environment(nodeProgram, null) })
    expect(choice.program).toBeNull()
  })
})

describe('run_code', () => {
  it('runs JavaScript with the app runtime and sets ELECTRON_RUN_AS_NODE', async () => {
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = []
    const tool = toolNamed(
      codeTools({
        tempRoot: folder,
        timeoutMs: 5_000,
        execPath: process.execPath,
        spawnImpl: ((file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
          calls.push({ file, args, env: options.env ?? {} })
          return fakeChild()
        }) as unknown as typeof import('node:child_process').spawn,
      }),
      'run_code',
    )
    const result = await tool.run(
      { language: 'javascript', code: 'console.log(1)' },
      testContext({ approve: async () => true }),
    )
    expect(calls[0]?.file).toBe(process.execPath)
    expect(calls[0]?.env['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(result).toContain('ran')
  })

  it('does not set ELECTRON_RUN_AS_NODE when a real Node was found', async () => {
    const calls: Array<{ env: NodeJS.ProcessEnv }> = []
    const tool = toolNamed(
      codeTools({
        tempRoot: folder,
        timeoutMs: 5_000,
        environment: environment(
          { path: process.execPath, prefix: [], kind: 'exe' },
          null,
        ),
        spawnImpl: ((_file: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
          calls.push({ env: options.env ?? {} })
          return fakeChild()
        }) as unknown as typeof import('node:child_process').spawn,
      }),
      'run_code',
    )
    await tool.run({ language: 'javascript', code: 'console.log(1)' }, testContext({ approve: async () => true }))
    expect(calls[0]?.env['ELECTRON_RUN_AS_NODE']).toBeUndefined()
  })

  it('always works with JavaScript, even with nothing installed', async () => {
    const tool = toolNamed(
      codeTools({
        tempRoot: folder,
        timeoutMs: 5_000,
        environment: environment(null, null),
        execPath: process.execPath,
      }),
      'run_code',
    )
    const result = await tool.run(
      { language: 'javascript', code: 'console.log(6 * 7)' },
      testContext({ approve: async () => true }),
    )
    expect(result).toContain('42')
  })

  it('runs Python through the launcher the scan found, with -3 before the script', async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const tool = toolNamed(
      codeTools({
        tempRoot: folder,
        timeoutMs: 5_000,
        environment: environment(null, pythonProgram),
        spawnImpl: ((file: string, args: string[]) => {
          calls.push({ file, args })
          return fakeChild()
        }) as unknown as typeof import('node:child_process').spawn,
      }),
      'run_code',
    )
    await tool.run({ language: 'python', code: 'print(1)' }, testContext({ approve: async () => true }))
    expect(calls[0]?.file).toBe('C:\\Python\\py.exe')
    expect(calls[0]?.args[0]).toBe('-3')
    expect(calls[0]?.args[1]?.endsWith('main.py')).toBe(true)
  })

  it('says Python is not installed and never tries to install it', async () => {
    const tool = toolNamed(
      codeTools({
        tempRoot: folder,
        timeoutMs: 5_000,
        environment: environment(null, null),
        execPath: process.execPath,
      }),
      'run_code',
    )
    const result = await tool.run(
      { language: 'python', code: 'print(1)' },
      testContext({ approve: async () => true }),
    )
    expect(result).toContain('Python is not installed on this computer')
    expect(result).toContain('did not try to install anything')
  })
})
