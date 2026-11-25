import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
