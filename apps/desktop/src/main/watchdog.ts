/**
 * Main-thread watchdog (30 Oct 2026). The app's main thread hung for seconds under a dozen helpers and Windows
 * killed it, with nothing in main.log to say where. Now a worker thread watches a heartbeat the main thread writes
 * every 100 ms. The worker also keeps a light sampling profile of the main thread (inspector, 10 ms samples) in
 * rolling windows; when the heartbeat stops for longer than `blockedMs`, the busiest call stacks of that stretch go
 * to main.log as "Main thread blocked", so the next hang is diagnosable from the log alone.
 *
 * It costs one timer on the main thread and well under 1% CPU. If the inspector is not available, the blocked time
 * is still logged, without stacks.
 */
import { Worker } from 'node:worker_threads'

export interface BlockedReport {
  ms: number
  /** When the stretch began (epoch ms, approximate). */
  at: number
  /** The busiest stacks in it, innermost frame first: "12ms run < setKv:db.ts < ...". */
  stacks: string[]
  /** Why there are no stacks, when there are none. */
  note?: string
}

export interface WatchdogOptions {
  /** Report a stretch at least this long. */
  blockedMs: number
  /** Rolling profile window. */
  windowMs?: number
  onBlocked: (report: BlockedReport) => void
  onError?: (why: string) => void
  /** Tests: no profiler. */
  profile?: boolean
}

export interface Watchdog {
  stop(): void
}

const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads')
const beat = new Float64Array(workerData.sab)
const blockedMs = workerData.blockedMs
const windowMs = workerData.windowMs
let session = null
let note = ''
if (workerData.profile) {
  try {
    const { Session } = require('node:inspector')
    session = new Session()
    session.connectToMainThread()
  } catch (error) { session = null; note = 'no inspector: ' + (error && error.message || error) }
}
const post = (method, params) => new Promise((resolve) => {
  if (session === null) return resolve(null)
  try { session.post(method, params || {}, (err, res) => resolve(err ? null : res)) } catch { resolve(null) }
})
let stalls = []
let inStall = 0
setInterval(() => {
  const now = Date.now()
  const last = beat[0]
  if (last === 0) return
  const gap = now - last
  if (gap > blockedMs) { if (inStall === 0) inStall = last }
  else if (inStall !== 0) { stalls.push({ at: inStall, ms: last - inStall }); inStall = 0 }
}, 50)

function frame(node) {
  const c = node.callFrame
  const file = (c.url || '').split(/[\\\\/]/).pop() || ''
  return (c.functionName || '(anon)') + (file ? ':' + file + ':' + (c.lineNumber + 1) : '')
}
function stacksOf(profile, minMs) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const parent = new Map()
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id)
  const idle = (id) => byId.get(id).callFrame.functionName === '(idle)'
  const s = profile.samples, d = profile.timeDeltas
  let best = null
  let i = 0
  while (i < s.length) {
    if (idle(s[i])) { i++; continue }
    let j = i, ms = 0
    while (j + 1 < s.length && !idle(s[j + 1])) { j++; ms += (d[j] || 0) / 1000 }
    if (ms >= minMs && (best === null || ms > best.ms)) best = { i, j, ms }
    i = j + 1
  }
  if (best === null) return []
  const agg = new Map()
  for (let k = best.i; k <= best.j; k++) {
    const dt = (d[k + 1] || 10000) / 1000
    const chain = []
    let cur = s[k]
    for (let x = 0; x < 12 && cur; x++) { const n = byId.get(cur); if (n.callFrame.functionName !== '(root)') chain.push(frame(n)); cur = parent.get(cur) }
    const key = chain.join(' < ')
    agg.set(key, (agg.get(key) || 0) + dt)
  }
  return [...agg].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => Math.round(v) + 'ms ' + k)
}
async function cycle() {
  if (session !== null) {
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval: 10000 })
  }
  for (;;) {
    if (session !== null) await post('Profiler.start')
    await new Promise((r) => setTimeout(r, windowMs))
    // A stall still going on is reported once it ends, in the window it ends in.
    while (inStall !== 0) await new Promise((r) => setTimeout(r, 100))
    const res = session !== null ? await post('Profiler.stop') : null
    const done = stalls.splice(0)
    if (done.length === 0) continue
    const longest = done.reduce((a, b) => (b.ms > a.ms ? b : a))
    let stacks = []
    try { stacks = res && res.profile ? stacksOf(res.profile, Math.max(100, longest.ms * 0.5)) : [] } catch (error) { note = 'stack summary failed: ' + (error && error.message || error) }
    parentPort.postMessage({ ms: Math.round(longest.ms), at: longest.at, stacks, count: done.length, note: stacks.length === 0 ? (note || 'no busy stretch in the profile') : undefined })
  }
}
cycle().catch((error) => parentPort.postMessage({ error: String(error && error.message || error) }))
`

/** Starts the watchdog. Returns a handle to stop it. Never throws: a watchdog that cannot start reports why. */
export function startWatchdog(options: WatchdogOptions): Watchdog {
  if (!(options.blockedMs > 0)) return { stop: () => undefined }
  const sab = new SharedArrayBuffer(8)
  const beat = new Float64Array(sab)
  beat[0] = Date.now()
  const timer = setInterval(() => {
    beat[0] = Date.now()
  }, 100)
  timer.unref?.()
  let worker: Worker | null = null
  try {
    worker = new Worker(WORKER_CODE, {
      eval: true,
      workerData: { sab, blockedMs: options.blockedMs, windowMs: options.windowMs ?? 20_000, profile: options.profile !== false },
    })
    worker.unref()
    worker.on('message', (m: { ms?: number; at?: number; stacks?: string[]; note?: string; error?: string; count?: number }) => {
      if (typeof m.error === 'string') {
        options.onError?.(m.error)
        return
      }
      options.onBlocked({ ms: m.ms ?? 0, at: m.at ?? 0, stacks: m.stacks ?? [], ...(m.note === undefined ? {} : { note: m.note }) })
    })
    worker.on('error', (error) => options.onError?.(error.message))
  } catch (error) {
    options.onError?.(error instanceof Error ? error.message : String(error))
  }
  return {
    stop: () => {
      clearInterval(timer)
      void worker?.terminate().catch(() => undefined)
      worker = null
    },
  }
}
