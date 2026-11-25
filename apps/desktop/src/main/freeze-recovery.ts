/** Separate process: recovery must not depend on the frozen Electron main thread or its logger. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export interface RecoveryOptions {
  parentPid: number
  executable: string
  args: string[]
  log: string
  state: string
  marker: string
  timeoutMs?: number
  intervalMs?: number
  startupMs?: number
  maxRestarts?: number
  windowMs?: number
  restartDelayMs?: number
  dataPath?: string
  diskIntervalMs?: number
}

/** Standalone source, also exercised against real disposable processes in tests. No Electron or app imports. */
export function recoveryWorkerCode(options: RecoveryOptions): string {
  return `
const fs = require('node:fs'), cp = require('node:child_process')
const o = ${JSON.stringify(options)}
const interval = o.intervalMs ?? 1000, timeout = o.timeoutMs ?? 60000
const started = Date.now()
let last = started, tickAt = started, memory = {}, recovering = false, heldForDisk = false
const log = (event, detail = {}) => {
  fs.appendFileSync(o.log, JSON.stringify({ at: new Date().toISOString(), event, parentPid: o.parentPid, ...detail }) + '\\n')
}
process.on('message', message => {
  if (message?.type === 'stop') process.exit(0)
  if (message?.type === 'beat') { last = Date.now(); memory = message.memory ?? {}; clearRecoveredHold(); if (message.ack && process.connected) process.send({ type: 'beatAck', id: message.ack }) }
})
process.on('disconnect', () => { if (!recovering) process.exit(0) })
let diskBlocked = false
function clearRecoveredHold() {
  if (!heldForDisk || diskBlocked || Date.now() - last >= timeout) return
  try { fs.rmSync(o.marker, { force: true }); heldForDisk = false; log('Main process responsive again after disk recovery') } catch {}
}
async function disk() {
  if (!o.dataPath) return
  try {
    const s = await fs.promises.statfs(o.dataPath)
    const free = Number(s.bavail) * Number(s.bsize) / 1073741824
    const total = Number(s.blocks) * Number(s.bsize) / 1073741824
    diskBlocked = free < Math.max(2, Math.min(5, total * 0.01))
    clearRecoveredHold()
    if (process.connected) process.send({ type: 'disk', free, total })
  } catch {}
}
disk(); if (o.dataPath) setInterval(disk, o.diskIntervalMs ?? 15000)

setInterval(() => {
  const now = Date.now(), scheduleGap = now - tickAt
  tickAt = now
  // Suspend/resume stalls both processes. Give the main thread a full fresh timeout after waking.
  if (scheduleGap > Math.max(timeout / 2, interval * 5)) { last = now; return }
  if (recovering || now - started < (o.startupMs ?? 120000) || now - last < timeout) return
  recovering = true
  try {
    let history = []
    try { history = JSON.parse(fs.readFileSync(o.state, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') { log('Recovery state unreadable; refusing restart'); process.exit(0) } }
    if (!Array.isArray(history) || history.some(t => typeof t !== 'number')) { log('Recovery state invalid; refusing restart'); process.exit(0) }
    history = history.filter(t => now - t < (o.windowMs ?? 1800000))
    if (diskBlocked) {
      if (!heldForDisk) {
        log('Main process frozen; restart held for low disk', { heartbeatAgeMs: now - last, memory })
        fs.writeFileSync(o.marker, JSON.stringify({ parentPid: o.parentPid, at: now, reason: 'frozen main held for low disk' }))
        heldForDisk = true
      }
      recovering = false
      return
    }
    // Persist diagnostics and availability before touching the process. If either write fails, do not kill it.
    log('Main process frozen', { heartbeatAgeMs: now - last, memory, note: 'Main thread did not answer; stack unavailable while blocked. See main.log for previous sampled stacks.' })
    fs.writeFileSync(o.marker, JSON.stringify({ parentPid: o.parentPid, at: now, reason: 'main process frozen' }))
    if (history.length >= (o.maxRestarts ?? 3)) { log('Restart cap reached', { attempts: history.length }); process.exit(0) }
    history.push(now)
    const temp = o.state + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(history)); fs.renameSync(temp, o.state)
    // Kill only the exact parent we were launched to watch. WAL and durable turn leases recover on startup.
    process.kill(o.parentPid, 'SIGKILL')
    log('Frozen main stopped', { attempt: history.length })
    setTimeout(() => {
      const child = cp.spawn(o.executable, o.args, { detached: true, stdio: 'ignore', windowsHide: true, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')) })
      child.once('error', error => { log('Relaunch failed', { why: error.message }); process.exit(0) })
      child.once('spawn', () => { log('Relaunched', { pid: child.pid }); child.unref(); process.exit(0) })
    }, o.restartDelayMs ?? Math.min(30000, 1000 * 2 ** (history.length - 1)))
  } catch (error) { try { log('Recovery refused or failed', { why: error.message }) } catch {} process.exit(0) }
}, interval)
`
}

export interface FreezeRecovery { stop(): void; unavailable(): boolean }
export function startFreezeRecovery(userData: string, executable: string, args: string[], onError: (why: string) => void, onDisk?: (freeGb: number, totalGb: number) => void): FreezeRecovery {
  mkdirSync(join(userData, 'logs'), { recursive: true })
  const marker = join(userData, 'logs', 'main-unavailable.json')
  // A new main process is healthy; the restart history deliberately survives it.
  rmSync(marker, { force: true })
  const child = spawn(executable, ['-e', recoveryWorkerCode({ parentPid: process.pid, executable, args, marker, dataPath: userData, log: join(userData, 'logs', 'freeze-watchdog.log'), state: join(userData, 'logs', 'freeze-restarts.json') })], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  let stopping = false
  child.on('error', error => onError(error.message))
  child.once('exit', (code, signal) => { clearInterval(timer); if (!stopping) onError(`Watchdog exited (${signal ?? code ?? 'unknown'}).`) })
  child.on('message', (message: { type?: string; free?: number; total?: number }) => { if (message.type === 'disk' && typeof message.free === 'number' && typeof message.total === 'number') onDisk?.(message.free, message.total) })
  const beat = (): void => { if (child.connected) child.send({ type: 'beat', memory: process.memoryUsage() }, error => { if (error !== null) onError(error.message) }) }
  const timer = setInterval(beat, 1000)
  timer.unref(); child.unref(); beat()
  return {
    unavailable: () => existsSync(marker),
    stop: () => { stopping = true; clearInterval(timer); if (child.connected) child.send({ type: 'stop' }, () => { if (child.connected) child.disconnect() }) },
  }
}
