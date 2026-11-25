/** Separate process: recovery must not depend on the frozen Electron main thread or its logger. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { startViaWmi } from './self-update'

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
  confirmStartup?: boolean
  startupConfirmMs?: number
  relaunchEnv?: Record<string, string>
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
process.on('error', error => { if (error.code !== 'EPIPE' && error.code !== 'ERR_IPC_CHANNEL_CLOSED') { try { log('Watchdog error', { why: error.message }) } catch {} } })
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
    const launch = () => {
      const child = cp.spawn(o.executable, o.args, { detached: true, stdio: 'ignore', windowsHide: true, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE')), ...o.relaunchEnv } })
      let finished = false, poll, deadline
      const retry = why => {
        if (finished) return
        finished = true; clearInterval(poll); clearTimeout(deadline)
        log('Replacement exited before startup', { why })
        if (history.length >= (o.maxRestarts ?? 3)) { log('Restart cap reached', { attempts: history.length }); process.exit(0) }
        history.push(Date.now())
        const next = o.state + '.tmp'
        fs.writeFileSync(next, JSON.stringify(history)); fs.renameSync(next, o.state)
        setTimeout(launch, o.restartDelayMs ?? Math.min(30000, 1000 * 2 ** (history.length - 1)))
      }
      child.once('error', error => retry(error.message))
      child.once('spawn', () => {
        log('Relaunched', { pid: child.pid })
        if (!o.confirmStartup) { child.unref(); process.exit(0); return }
        // A successful CreateProcess is not a running app. Windows may still hold its old single-instance lock.
        // Keep the launching supervisor alive until the new main has opened its own supervisor, or retry a refused start.
        poll = setInterval(() => { if (!fs.existsSync(o.marker)) { finished = true; clearInterval(poll); clearTimeout(deadline); log('Replacement ready', { pid: child.pid }); child.unref(); process.exit(0) } }, 50)
        deadline = setTimeout(() => { log('Replacement startup timed out', { pid: child.pid }); child.kill('SIGKILL') }, o.startupConfirmMs ?? 120000)
      })
      child.once('exit', (code, signal) => { if (o.confirmStartup) retry(String(signal ?? code ?? 'unknown')) })
    }
    setTimeout(launch, o.restartDelayMs ?? Math.min(30000, 1000 * 2 ** (history.length - 1)))
  } catch (error) { try { log('Recovery refused or failed', { why: error.message }) } catch {} process.exit(0) }
}, interval)
`
}

/** A WMI-created process cannot inherit Electron's Windows job; a local authenticated socket carries heartbeats. */
export function recoverySocketBootstrap(port: number, token: string): string {
  return `
const channel = require('node:net').connect(${port}, '127.0.0.1')
let connected = true, identified = false, buffer = '', queued = []
Object.defineProperty(process, 'connected', { get: () => connected })
process.send = message => { if (connected) { const line = JSON.stringify(message) + '\\n'; if (identified) channel.write(line); else queued.push(line) }; return connected }
channel.once('connect', () => { channel.write(JSON.stringify({ token: ${JSON.stringify(token)} }) + '\\n'); identified = true; for (const line of queued) channel.write(line); queued = [] })
channel.on('data', chunk => { buffer += chunk; let i; while ((i = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); try { process.emit('message', JSON.parse(line)) } catch {} } })
channel.on('error', () => { connected = false; process.emit('disconnect') })
channel.on('close', () => { connected = false; process.emit('disconnect') })
`
}
export interface FreezeRecovery { ready?: Promise<void>; stop(): void; unavailable(): boolean }
export function startFreezeRecovery(userData: string, executable: string, args: string[], onError: (why: string) => void, onDisk?: (freeGb: number, totalGb: number) => void): FreezeRecovery {
  mkdirSync(join(userData, 'logs'), { recursive: true })
  const marker = join(userData, 'logs', 'main-unavailable.json')
  rmSync(marker, { force: true })
  const options: RecoveryOptions = { parentPid: process.pid, executable, args, marker, dataPath: userData, log: join(userData, 'logs', 'freeze-watchdog.log'), state: join(userData, 'logs', 'freeze-restarts.json') }
  const diskMessage = (message: { type?: string; free?: number; total?: number }): void => { if (message.type === 'disk' && typeof message.free === 'number' && typeof message.total === 'number') onDisk?.(message.free, message.total) }
  if (process.platform !== 'win32') {
    const child = spawn(executable, ['-e', recoveryWorkerCode(options)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    let stopping = false
    child.on('error', error => onError(error.message))
    child.once('exit', (code, signal) => { clearInterval(timer); if (!stopping) onError(`Watchdog exited (${signal ?? code ?? 'unknown'}).`) })
    child.on('message', diskMessage)
    const beat = (): void => { if (child.connected) child.send({ type: 'beat', memory: process.memoryUsage() }, error => { if (error !== null) onError(error.message) }) }
    const timer = setInterval(beat, 1000)
    timer.unref(); child.unref(); beat()
    return { unavailable: () => existsSync(marker), stop: () => { stopping = true; clearInterval(timer); if (child.connected) child.send({ type: 'stop' }, () => { if (child.connected) child.disconnect() }) } }
  }
  let socket: Socket | undefined, stopping = false, timer: ReturnType<typeof setInterval> | undefined
  const token = randomBytes(32).toString('hex')
  const script = join(userData, 'logs', `freeze-supervisor-${process.pid}.cjs`)
  const server = createServer(client => {
    let buffer = '', accepted = false
    client.on('error', () => undefined)
    client.on('data', chunk => {
      buffer += chunk
      if (buffer.length > 65536) { client.destroy(); return }
      let i: number
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1)
        try {
          const message = JSON.parse(line)
          if (!accepted) {
            if (message.token !== token || socket !== undefined || stopping) { client.destroy(); return }
            accepted = true; socket = client
            const beat = (): void => { if (!client.destroyed) client.write(JSON.stringify({ type: 'beat', memory: process.memoryUsage() }) + '\n') }
            timer = setInterval(beat, 1000); timer.unref(); beat(); settled()
          } else diskMessage(message)
        } catch { client.destroy(); return }
      }
    })
    client.on('close', () => { if (accepted) { if (timer) clearInterval(timer); if (!stopping) onError('Freeze watchdog disconnected.') } })
  })
  let settled = (): void => undefined
  const ready = new Promise<void>(resolve => {
    const timeout = setTimeout(() => { onError('Freeze watchdog did not connect within 30 seconds.'); resolve() }, 30000)
    settled = () => { clearTimeout(timeout); resolve() }
    server.on('error', error => { onError(error.message); settled() })
    server.listen(0, '127.0.0.1', () => {
      if (stopping) { settled(); return }
      const address = server.address()
      if (address === null || typeof address === 'string') { settled(); return }
      // Preserve only launch-path choices. Account credentials remain in their normal encrypted/home stores.
      options.confirmStartup = true
      options.relaunchEnv = { AGENT_USER_DATA: userData, AGENT_CODEX_PATH: process.env['AGENT_CODEX_PATH'] ?? '', AGENT_CLAUDE_PATH: process.env['AGENT_CLAUDE_PATH'] ?? '' }
      const cleanup = `process.on('exit', () => { try { require('node:fs').unlinkSync(__filename) } catch {} });\n`
      writeFileSync(script, cleanup + recoverySocketBootstrap(address.port, token) + recoveryWorkerCode(options), { mode: 0o600 })
      const quote = (value: string): string => "'" + value.replaceAll("'", "''") + "'"
      const ps = `$env:ELECTRON_RUN_AS_NODE='1'; & ${quote(executable)} ${quote(script)}`
      const command = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`
      void startViaWmi(command).catch(error => { onError(String(error)); settled() })
    })
  })
  server.unref()
  return { ready, unavailable: () => existsSync(marker), stop: () => { stopping = true; if (timer) clearInterval(timer); socket?.end(JSON.stringify({ type: 'stop' }) + '\n'); server.close(); settled() } }
}
