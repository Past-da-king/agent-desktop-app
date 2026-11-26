import { safeSocketEnd, safeSocketWrite } from './runtime/safe-pipe'
/** Separate process: recovery must not depend on the frozen Electron main thread or its logger. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  /** How often the Devices server is asked a real question (GET /v1/health?deep=1). */
  probeIntervalMs?: number
  /** How long one answer may take. */
  probeTimeoutMs?: number
  /**
   * How long the Devices server may go without one good answer, while the main thread still beats, before the app
   * counts as frozen. Only after it has answered once since this start (a server that never came up is not frozen).
   */
  probeDeadMs?: number
}

/** Where the supervisor asks its question: the Devices server's own port, on this computer. */
export interface ProbeTarget {
  host: string
  port: number
}

/** Standalone source, also exercised against real disposable processes in tests. No Electron or app imports. */
export function recoveryWorkerCode(options: RecoveryOptions): string {
  return `
const fs = require('node:fs'), cp = require('node:child_process'), https = require('node:https')
const o = ${JSON.stringify(options)}
const interval = o.intervalMs ?? 1000, timeout = o.timeoutMs ?? 60000
// Monotonic time for every age and deadline: the wall clock can be wrong or jump (26 Nov 2026: a Windows clock 35
// minutes slow), and an age taken from it is wrong by as much. Date.now() only stamps logs and the restart history.
const mono = () => performance.now()
const started = mono()
let last = started, tickAt = started, memory = {}, recovering = false, heldForDisk = false
// The Devices server, asked a real question on the path other devices use (TLS, routing, a read through the
// database's read queue). A main thread that still beats while that path is stuck (26 Nov 2026: every database read
// waited 20 minutes, links failed in the TLS handshake) is frozen for everyone who needs it.
let probeTarget = null, probeOkAt = 0, probeArmed = false, probing = false, probeFailing = ''
const probeInterval = o.probeIntervalMs ?? 15000, probeTimeout = o.probeTimeoutMs ?? 10000, probeDead = o.probeDeadMs ?? 180000
const log = (event, detail = {}) => {
  fs.appendFileSync(o.log, JSON.stringify({ at: new Date().toISOString(), event, parentPid: o.parentPid, ...detail }) + '\\n')
}
function setProbe(target) {
  const next = target && typeof target.port === 'number' && target.port > 0 ? { host: typeof target.host === 'string' && target.host !== '' ? target.host : '127.0.0.1', port: target.port } : null
  if (JSON.stringify(next) === JSON.stringify(probeTarget)) return
  // A new or restarted server gets a full fresh grace, and has to answer once before it can count as stuck.
  probeTarget = next; probeArmed = false; probeOkAt = mono(); probeFailing = ''
}
function probe() {
  const target = probeTarget
  if (target === null || probing || recovering) return
  probing = true
  const sent = mono()
  let settled = false
  const done = (ok, why) => {
    if (settled) return
    settled = true; probing = false
    if (JSON.stringify(target) !== JSON.stringify(probeTarget)) return
    if (ok) {
      if (probeFailing !== '') log('Devices server answering again', { afterMs: Math.round(mono() - probeOkAt) })
      probeOkAt = mono(); probeArmed = true; probeFailing = ''
    } else if (probeFailing === '') { probeFailing = why; log('Devices server not answering', { why, armed: probeArmed }) }
  }
  try {
    const req = https.get({ host: target.host, port: target.port, path: '/v1/health?deep=1', rejectUnauthorized: false, agent: false, timeout: probeTimeout, headers: { 'user-agent': 'agent-freeze-supervisor' } }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { if (body.length < 8192) body += chunk })
      res.on('end', () => {
        let deep = ''
        try { deep = String(JSON.parse(body).deep ?? '') } catch {}
        done(res.statusCode === 200 && deep === 'ok', 'status ' + res.statusCode + (deep ? ' (' + deep + ')' : ''))
      })
      res.on('error', error => done(false, error.message))
    })
    req.on('timeout', () => { req.destroy(new Error('no answer in ' + probeTimeout + ' ms')) })
    req.on('error', error => done(false, error.code ?? error.message))
    // A hung TLS handshake may never raise 'timeout' on the request: a deadline of our own.
    setTimeout(() => { if (!settled) { try { req.destroy() } catch {} done(false, 'no answer in ' + Math.round(mono() - sent) + ' ms') } }, probeTimeout + 1000).unref?.()
  } catch (error) { done(false, error.message) }
}
setInterval(probe, probeInterval)
process.on('message', message => {
  if (message?.type === 'stop') process.exit(0)
  if (message?.type === 'beat') { last = mono(); memory = message.memory ?? {}; if ('probe' in message) setProbe(message.probe); clearRecoveredHold(); if (message.ack && process.connected) process.send({ type: 'beatAck', id: message.ack }) }
})
process.on('disconnect', () => { if (!recovering) process.exit(0) })
process.on('error', error => { if (error.code !== 'EPIPE' && error.code !== 'ERR_IPC_CHANNEL_CLOSED') { try { log('Watchdog error', { why: error.message }) } catch {} } })
let diskBlocked = false
function clearRecoveredHold() {
  if (!heldForDisk || diskBlocked || mono() - last >= timeout) return
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
  const now = mono(), scheduleGap = now - tickAt, wall = Date.now()
  tickAt = now
  // Suspend/resume stalls both processes. Give the main thread (and the Devices server) a full fresh timeout after waking.
  if (scheduleGap > Math.max(timeout / 2, interval * 5)) { last = now; probeOkAt = now; return }
  if (recovering || now - started < (o.startupMs ?? 120000)) return
  const beatStale = now - last >= timeout
  const serverStuck = !beatStale && probeTarget !== null && probeArmed && now - probeOkAt >= probeDead
  if (!beatStale && !serverStuck) return
  recovering = true
  try {
    let history = []
    try { history = JSON.parse(fs.readFileSync(o.state, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') { log('Recovery state unreadable; refusing restart'); process.exit(0) } }
    if (!Array.isArray(history) || history.some(t => typeof t !== 'number')) { log('Recovery state invalid; refusing restart'); process.exit(0) }
    // Restarts are stamped with the wall clock (they outlive this process). A stamp in the future (the clock went
    // back) has a negative age, so it still counts as recent: a clock change can never lift the cap.
    history = history.filter(t => wall - t < (o.windowMs ?? 1800000))
    if (diskBlocked) {
      if (!heldForDisk) {
        log('Main process frozen; restart held for low disk', { heartbeatAgeMs: Math.round(now - last), memory, ...(serverStuck ? { devicesServer: probeFailing || 'not answering' } : {}) })
        fs.writeFileSync(o.marker, JSON.stringify({ parentPid: o.parentPid, at: wall, reason: 'frozen main held for low disk' }))
        heldForDisk = true
      }
      recovering = false
      return
    }
    // Persist diagnostics and availability before touching the process. If either write fails, do not kill it.
    if (serverStuck) log('Main process frozen', { heartbeatAgeMs: Math.round(now - last), memory, devicesServer: probeFailing || 'not answering', noAnswerMs: Math.round(now - probeOkAt), note: 'The main thread still beats, but the Devices server has not answered a real request; other devices cannot reach this app.' })
    else log('Main process frozen', { heartbeatAgeMs: Math.round(now - last), memory, note: 'Main thread did not answer; stack unavailable while blocked. See main.log for previous sampled stacks.' })
    fs.writeFileSync(o.marker, JSON.stringify({ parentPid: o.parentPid, at: wall, reason: serverStuck ? 'devices server not answering' : 'main process frozen' }))
    if (history.length >= (o.maxRestarts ?? 3)) { log('Restart cap reached', { attempts: history.length }); process.exit(0) }
    history.push(wall)
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
/** Deletes freeze-supervisor-<pid>.cjs files whose app process is no longer running. */
export function removeStaleSupervisorScripts(dir: string, alive: (pid: number) => boolean = processAlive): number {
  let removed = 0
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    const pid = Number(/^freeze-supervisor-(\d+)\.cjs$/.exec(name)?.[1] ?? NaN)
    if (!Number.isInteger(pid) || pid === process.pid || alive(pid)) continue
    try {
      rmSync(join(dir, name), { force: true })
      removed += 1
    } catch {
      // in use or already gone
    }
  }
  return removed
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface FreezeRecovery { ready?: Promise<void>; stop(): void; unavailable(): boolean }
export function startFreezeRecovery(
  userData: string,
  executable: string,
  args: string[],
  onError: (why: string) => void,
  onDisk?: (freeGb: number, totalGb: number) => void,
  /** Where the Devices server answers now, or null while it does not listen (sent with every beat). */
  probe?: () => ProbeTarget | null,
): FreezeRecovery {
  const probeNow = (): ProbeTarget | null => {
    try {
      return probe?.() ?? null
    } catch {
      return null
    }
  }
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
    const beat = (): void => { if (child.connected) child.send({ type: 'beat', memory: process.memoryUsage(), probe: probeNow() }, error => { if (error !== null) onError(error.message) }) }
    const timer = setInterval(beat, 1000)
    timer.unref(); child.unref(); beat()
    return { unavailable: () => existsSync(marker), stop: () => { stopping = true; clearInterval(timer); if (child.connected) child.send({ type: 'stop' }, () => { if (child.connected) child.disconnect() }) } }
  }
  // Scripts of supervisors that are gone (a shutdown kills them before they can delete their own): tidy them away.
  removeStaleSupervisorScripts(join(userData, 'logs'))
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
            if (late) onError(`Freeze watchdog connected late, after ${Math.round(performance.now() - begun)} ms; supervising now.`)
            const beat = (): void => { if (!client.destroyed) safeSocketWrite(client, JSON.stringify({ type: 'beat', memory: process.memoryUsage(), probe: probeNow() }) + '\n') }
            timer = setInterval(beat, 1000); timer.unref(); beat(); settled()
          } else diskMessage(message)
        } catch { client.destroy(); return }
      }
    })
    client.on('close', () => { if (accepted) { if (timer) clearInterval(timer); if (!stopping) onError('Freeze watchdog disconnected.') } })
  })
  let settled = (): void => undefined
  // A slow start (26 Nov 2026: the main thread blocked 37 s while it started) can hold the supervisor past 30 s.
  // The app does not wait longer, but it keeps listening and says when the supervisor does connect.
  let late = false
  const begun = performance.now()
  const ready = new Promise<void>(resolve => {
    const timeout = setTimeout(() => { late = true; onError('Freeze watchdog did not connect within 30 seconds; still waiting for it.'); resolve() }, 30000)
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
  return { ready, unavailable: () => existsSync(marker), stop: () => { stopping = true; if (timer) clearInterval(timer); socket && safeSocketEnd(socket, JSON.stringify({ type: 'stop' }) + '\n'); server.close(); settled() } }
}
