/**
 * Measures the window's first chat list before (list + lightRow, as 0.2.146 did) and after (listLight) on a made-up
 * chat table shaped like a real one. Skipped unless LIGHT_BENCH=<rows> is set: it writes a large database.
 *   LIGHT_BENCH=20000 npx vitest run test/db-light-list-bench.test.ts
 */
import { appendFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'

import { expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { lightRow } from '../src/shared/light-row'

const rows = Number(process.env['LIGHT_BENCH'] ?? 0)
/** Where the numbers go (LIGHT_BENCH_OUT), besides the console. */
const report = (line: string): void => {
  console.log(line)
  const out = process.env['LIGHT_BENCH_OUT']
  if (out !== undefined && out !== '') appendFileSync(out, `${line}\n`)
}

it.skipIf(!(rows > 0))('first chat list: list()+lightRow versus listLight()', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'light-bench-'))
  try {
    const db = new Store(join(dir, 'agent.db'))
    // Roughly the real mix: most rows are tool steps, a third of those with long command output.
    await db.batch(async () => {
      for (let i = 0; i < rows; i += 1) {
        const step = i % 4 !== 0
        const long = step && i % 3 === 0
        const meta = step
          ? JSON.stringify({ chat: 'main', run: { tool: 'shell_run', status: 'done', input: JSON.stringify({ command: 'x'.repeat(long ? 3000 : 80) }), stdout: (long ? 'out ' : 'ok ').repeat(long ? 6000 : 20), stderr: '' } })
          : JSON.stringify({ chat: 'main' })
        await db.upsert('chat_item', { kind: step ? 'activity' : 'agent', text: step ? `step ${i}` : 'A reply. '.repeat(40), meta })
      }
    })
    db.startReader()
    const stored = statSync(join(dir, 'agent.db')).size
    const measure = async (label: string, read: () => Promise<unknown[]>): Promise<{ ms: number; bytes: number; heapMb: number }> => {
      global.gc?.()
      const heapBefore = process.memoryUsage().heapUsed
      // How long the main thread (the window's links, timers, the devices server) was held at a time, and in total.
      const loop = monitorEventLoopDelay({ resolution: 10 })
      loop.enable()
      const cpuBefore = process.cpuUsage()
      const started = performance.now()
      const out = (await read()) as Array<{ text: string; meta: string }>
      const ms = performance.now() - started
      loop.disable()
      const cpu = process.cpuUsage(cpuBefore)
      const mainCpuMs = Math.round((cpu.user + cpu.system) / 1000)
      const worstStallMs = Math.round(loop.max / 1e6)
      const bytes = out.reduce((sum, row) => sum + row.text.length + row.meta.length, 0)
      const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1048576
      const crossed = db.recentReads(0).filter((note) => note.what.startsWith('list chat_item')).at(-1)
      report(`${label}: ${Math.round(ms)} ms, ${(bytes / 1048576).toFixed(1)} MB listed, ${crossed === undefined ? '?' : (crossed.bytes / 1048576).toFixed(1)} MB from the worker, process CPU ${mainCpuMs} ms, worst main-thread stall ${worstStallMs} ms`)
      return { ms, bytes, heapMb }
    }
    report(`${rows} chat rows, database ${(stored / 1048576).toFixed(0)} MB`)
    const before = await measure('before (list + lightRow)', async () => (await db.list('chat_item')).map((row) => lightRow('chat_item', row)))
    const after = await measure('after (listLight)', () => db.listLight('chat_item'))
    expect(after.bytes).toBe(before.bytes)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 600_000)
