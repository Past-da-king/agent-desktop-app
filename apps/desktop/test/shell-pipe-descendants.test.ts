import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { codeTools } from '../src/main/tools/code'
import { shellTools } from '../src/main/tools/shell'
import { guardChild } from '../src/main/runtime/safe-pipe'
import { settingsView, testContext, toolNamed } from './support'

function alive(pid: number): boolean {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] !== 'Z' } catch { return false }
}
async function waitUntil(check: () => boolean, limit = 2500): Promise<void> {
  const until = Date.now() + limit
  while (!check() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20))
}

describe.skipIf(process.platform !== 'linux')('real shell descendant cleanup', () => {
  it.each(['EOF', 'timeout', 'cancel'])('%s leaves no owned descendant running', async (mode) => {
    const folder = mkdtempSync(join(tmpdir(), 'shell-pipe-tree-'))
    const parentFile = join(folder, 'parent.cjs'), pidFile = join(folder, 'descendant.pid')
    writeFileSync(parentFile, `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.stdout.write('ready'); setInterval(()=>{},1000);`)
    let child: ChildProcess | undefined, descendant = 0
    const controller = new AbortController()
    const spawnImpl = ((file: string, args: string[], options: object) => { child = guardChild(spawn(file, args, options)); return child }) as typeof spawn
    const tool = toolNamed(shellTools({ settings: settingsView({ shell: 'ask' }), platform: 'linux', spawnImpl }), 'shell_run')
    try {
      const running = tool.run({ command: `${JSON.stringify(process.execPath)} ${JSON.stringify(parentFile)}`, timeoutSec: 1 }, testContext({ approve: async () => true, signal: controller.signal }))
      await waitUntil(() => { try { descendant = Number(readFileSync(pidFile, 'utf8')); return descendant > 0 } catch { return false } })
      expect(descendant).toBeGreaterThan(0)
      if (mode === 'EOF') child!.stdout!.emit('error', Object.assign(new Error('write EOF'), { code: 'EOF' }))
      if (mode === 'cancel') controller.abort()
      const result = await running
      if (mode === 'EOF') expect(result).toContain('engine process ended: write EOF')
      if (mode === 'timeout') expect(result).toContain('Timed out')
      if (mode === 'cancel') expect(result).toContain('Stopped by the user')
      await waitUntil(() => !alive(descendant), 1600)
      expect(alive(descendant)).toBe(false)
    } finally {
      controller.abort()
      // Only the process group and child recorded by this isolated fixture are eligible for cleanup.
      if (child?.pid !== undefined) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ } }
      if (descendant > 0 && alive(descendant)) { try { process.kill(descendant, 'SIGKILL') } catch { /* already gone */ } }
      rmSync(folder, { recursive: true, force: true })
    }
  })
})


describe.skipIf(process.platform !== 'linux')('leader exited before pipe failure', () => {
  it.each([['shell', 'cancel'], ['shell', 'deadline'], ['code', 'cancel'], ['code', 'deadline']] as const)('%s keeps tree protection through late EOF and %s', async (kind, after) => {
    const folder = mkdtempSync(join(tmpdir(), 'late-pipe-tree-'))
    const parentFile = join(folder, 'parent.cjs'), pidFile = join(folder, 'descendant.pid')
    const source = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref();process.exit(0);`
    writeFileSync(parentFile, source)
    let child: ChildProcess | undefined, descendant = 0, completions = 0
    let restoreKill: (() => void) | undefined
    const controller = new AbortController()
    const spawnImpl = ((file: string, args: string[], options: object) => { child = guardChild(spawn(file, args, options)); return child }) as typeof spawn
    const tool = kind === 'shell'
      ? toolNamed(shellTools({ settings: settingsView({ shell: 'ask' }), platform: 'linux', spawnImpl }), 'shell_run')
      : toolNamed(codeTools({ tempRoot: folder, timeoutMs: 1000, spawnImpl, platform: 'linux' }), 'run_code')
    try {
      const input = kind === 'shell' ? { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(parentFile)}`, timeoutSec: 1 } : { language: 'javascript', code: `import {createRequire} from 'node:module';const require=createRequire(import.meta.url);${source}` }
      const running = tool.run(input, testContext({ approve: async () => true, signal: controller.signal })).then(result => { completions++; return result })
      await waitUntil(() => { try { descendant = Number(readFileSync(pidFile, 'utf8')); return descendant > 0 && child?.exitCode === 0 } catch { return false } })
      expect(child?.exitCode).toBe(0)
      expect(alive(descendant)).toBe(true)
      if (process.env['PIPE_BASELINE_NO_EOF'] !== '1') {
        // A cleanup attempt need not have finished the tree. Prove abort/deadline protection stays armed.
        const kill = process.kill
        let firstGroupAttempt = true
        const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === -child!.pid! && signal === 'SIGKILL' && firstGroupAttempt) { firstGroupAttempt = false; throw Object.assign(new Error('fixture cleanup not yet permitted'), { code: 'EPERM' }) }
          return kill.call(process, pid, signal)
        })
        restoreKill = () => spy.mockRestore()
        child!.stdout!.emit('error', Object.assign(new Error('write EOF'), { code: 'EOF' }))
      }
      if (after === 'cancel') controller.abort()
      await running
      await waitUntil(() => !alive(descendant), 1400)
      expect(alive(descendant)).toBe(false)
      expect(completions).toBe(1)
    } finally {
      restoreKill?.()
      controller.abort()
      if (child?.pid !== undefined) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* fixture group gone */ } }
      if (descendant > 0 && alive(descendant)) { try { process.kill(descendant, 'SIGKILL') } catch { /* gone */ } }
      rmSync(folder, { recursive: true, force: true })
    }
  })
})


describe.skipIf(process.platform !== 'linux')('settled run tree ownership', () => {
  it.each(['shell', 'code'] as const)('%s ignores EOF, abort and deadline after normal close', async (kind) => {
    const folder = mkdtempSync(join(tmpdir(), 'settled-pipe-tree-'))
    let child: ChildProcess | undefined
    const controller = new AbortController()
    const spawnImpl = ((file: string, args: string[], options: object) => { child = guardChild(spawn(file, args, options)); return child }) as typeof spawn
    const tool = kind === 'shell'
      ? toolNamed(shellTools({ settings: settingsView({ shell: 'ask' }), platform: 'linux', spawnImpl }), 'shell_run')
      : toolNamed(codeTools({ tempRoot: folder, timeoutMs: 1000, spawnImpl, platform: 'linux' }), 'run_code')
    let spy: ReturnType<typeof vi.spyOn> | undefined
    try {
      const input = kind === 'shell' ? { command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`, timeoutSec: 1 } : { language: 'javascript', code: 'process.exit(0)' }
      await tool.run(input, testContext({ approve: async () => true, signal: controller.signal }))
      expect(child?.exitCode).toBe(0)
      // A stale numeric group could now belong to another run. No probe or signal is allowed.
      spy = vi.spyOn(process, 'kill').mockReturnValue(true)
      child!.stdout!.emit('error', Object.assign(new Error('write EOF'), { code: 'EOF' }))
      controller.abort()
      await new Promise(resolve => setTimeout(resolve, 1100))
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy?.mockRestore()
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
