#!/usr/bin/env node
/**
 * Devices end-to-end live harness (docs/devices-protocol.md). Plain Node 22+, no dependencies, no test framework.
 *
 * It acts as a PHONE speaking the exact phone protocol against REAL running nodes: it pins each node's certificate by
 * fingerprint, pairs with POST /v1/pair as kind "phone", says hello over /v1/rpc with a small tool catalogue
 * (notify, ask_user, browser_open stub), answers `device.command` (device.ack / device.result), and runs numbered
 * checks that print PASS / FAIL / SKIP with evidence.
 *
 * Nothing about any person, host or key is in this file: every address, code and command comes from the flags.
 *
 *   node scripts/devices-e2e.mjs --brain https://<first brain>:7787 --code ABCD-EFGH \
 *        [--brain https://<second brain>:7787 ...]                 ranked, best first
 *        [--stop-cmd '<shell command that stops brain 1>' ...]     one per --brain, same order ('' to skip)
 *        [--start-cmd '<shell command that starts brain 1>' ...]   one per --brain, same order
 *        [--image /abs/path/on/the/brain.png] [--project <name>] [--timeout 240] [--only a,c,f] [--state file]
 *
 * --code takes the short code (the first connection is then trusted and its fingerprint printed) or the whole
 * agent://pair?... link (fingerprint and addresses from the link). Pairing is saved in --state (default
 * ./devices-e2e-state.json) so a later run can skip --code. The state file holds this test phone's pass: delete it
 * when done, and revoke "E2E test phone" in Settings > Devices.
 *
 * Checks: a chat round trip | b data and bundle, no secrets | c project agent row | d /v1/file image |
 *         e open_url and device tools reach this phone | f failover to the next brain | g crash resume exactly once
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { spawnSync } from 'node:child_process'

// ---- flags --------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { brain: [], stopCmd: [], startCmd: [], only: null, timeout: 240, state: 'devices-e2e-state.json', code: '', image: '', project: '', name: 'E2E test phone', quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${flag} needs a value`)
      return value
    }
    if (flag === '--brain') out.brain.push(next().replace(/\/+$/, ''))
    else if (flag === '--stop-cmd') out.stopCmd.push(next())
    else if (flag === '--start-cmd') out.startCmd.push(next())
    else if (flag === '--code') out.code = next()
    else if (flag === '--only') out.only = new Set(next().split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
    else if (flag === '--timeout') out.timeout = Number(next())
    else if (flag === '--state') out.state = next()
    else if (flag === '--image') out.image = next()
    else if (flag === '--project') out.project = next()
    else if (flag === '--name') out.name = next()
    else if (flag === '--quiet') out.quiet = true
    else if (flag === '--help' || flag === '-h') {
      console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0])
      process.exit(0)
    } else throw new Error(`unknown flag ${flag}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const TIMEOUT_MS = Math.max(30, args.timeout) * 1000
const log = (...parts) => {
  if (!args.quiet) console.log('   ', ...parts)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const nonce = () => randomBytes(4).toString('hex')

// ---- pinned TLS ---------------------------------------------------------------------------------------------------

const fpOf = (der) => createHash('sha256').update(der).digest('base64url')

/** Words to compare a fingerprint by eye. */
function fpWords(fp) {
  const words = ['amber', 'birch', 'cedar', 'delta', 'ember', 'fable', 'grove', 'harbor', 'ivory', 'jasper', 'kettle', 'lumen', 'maple', 'nectar', 'onyx', 'pebble']
  const bytes = Buffer.from(fp, 'base64url')
  return [0, 1, 2, 3].map((i) => words[(bytes[i] ?? 0) % words.length]).join(' ')
}

/** A TLS socket to `url`, refused unless its certificate is `fp` ('' = trust on first use, returns what it saw). */
function pinnedSocket(url, fp) {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 443), servername: undefined, rejectUnauthorized: false })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`no TLS answer from ${target.host}`))
    }, 10_000)
    socket.once('secureConnect', () => {
      clearTimeout(timer)
      const raw = socket.getPeerCertificate()?.raw
      const seen = raw ? fpOf(raw) : ''
      if (seen === '' || (fp !== '' && seen !== fp)) {
        socket.destroy()
        reject(new Error(`certificate of ${target.host} is not the paired one`))
        return
      }
      resolve({ socket, fp: seen })
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** One HTTPS request, pinned. Nothing is written before the pin check. */
function pinnedRequest(url, fp, { method = 'GET', headers = {}, body, timeoutMs = 15_000 } = {}) {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    const req = httpsRequest({
      host: target.hostname.replace(/^\[|\]$/g, ''),
      port: Number(target.port || 443),
      path: `${target.pathname}${target.search}`,
      method,
      headers: { ...headers, ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) },
      rejectUnauthorized: false,
      agent: false,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), seenFp: req.seenFp }))
      res.on('error', reject)
    })
    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        const raw = socket.getPeerCertificate()?.raw
        const seen = raw ? fpOf(raw) : ''
        req.seenFp = seen
        if (seen === '' || (fp !== '' && seen !== fp)) {
          req.destroy(new Error(`certificate of ${target.host} is not the paired one`))
          return
        }
        req.end(payload)
      })
    })
    req.on('timeout', () => req.destroy(new Error(`no answer from ${target.host} in time`)))
    req.on('error', reject)
  })
}

const json = (res) => {
  try {
    return JSON.parse(res.body.toString('utf8'))
  } catch {
    return null
  }
}

// ---- a minimal WebSocket client (RFC 6455, client side) -------------------------------------------------------------

class Ws {
  constructor(socket) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.handlers = new Set()
    this.closeHandlers = new Set()
    this.open = true
    socket.on('data', (chunk) => this.onData(chunk))
    socket.on('close', () => this.onClosed())
    socket.on('error', () => this.onClosed())
  }

  static async connect(base, fp, pass) {
    const { socket } = await pinnedSocket(base, fp)
    const target = new URL(base)
    const key = randomBytes(16).toString('base64')
    socket.write(['GET /v1/rpc HTTP/1.1', `Host: ${target.host}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', `Authorization: Bearer ${pass}`, '', ''].join('\r\n'))
    const leftover = await new Promise((resolve, reject) => {
      let got = Buffer.alloc(0)
      const timer = setTimeout(() => done(new Error('no WebSocket answer')), 10_000)
      const onData = (chunk) => {
        got = Buffer.concat([got, chunk])
        const end = got.indexOf('\r\n\r\n')
        if (end < 0) return
        const head = got.subarray(0, end).toString('latin1')
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0)
        if (status !== 101) return done(new Error(`WebSocket refused: HTTP ${status}`))
        done(null, got.subarray(end + 4))
      }
      const done = (error, rest) => {
        clearTimeout(timer)
        socket.off('data', onData)
        if (error) {
          socket.destroy()
          reject(error)
        } else resolve(rest)
      }
      socket.on('data', onData)
      socket.once('error', (e) => done(e))
    })
    const ws = new Ws(socket)
    if (leftover.length > 0) ws.onData(leftover)
    return ws
  }

  onMessage(handler) {
    this.handlers.add(handler)
  }

  onClose(handler) {
    this.closeHandlers.add(handler)
  }

  send(text) {
    this.frame(1, Buffer.from(text, 'utf8'))
  }

  close() {
    if (!this.open) return
    try {
      this.frame(8, Buffer.from([0x03, 0xe8]))
    } catch {
      // already gone
    }
    this.socket.end()
    this.onClosed()
  }

  frame(opcode, payload) {
    if (!this.open) return
    const mask = randomBytes(4)
    const len = payload.length
    const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len]) : len < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b })()])
    const body = Buffer.alloc(len)
    for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i % 4]
    this.socket.write(Buffer.concat([head, mask, body]))
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.buffer.length < 2) return
      const b0 = this.buffer[0]
      const b1 = this.buffer[1]
      let len = b1 & 0x7f
      let offset = 2
      if (len === 126) {
        if (this.buffer.length < 4) return
        len = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (this.buffer.length < 10) return
        len = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      const masked = (b1 & 0x80) !== 0
      const maskBytes = masked ? this.buffer.subarray(offset, offset + 4) : null
      if (masked) offset += 4
      if (this.buffer.length < offset + len) return
      let payload = Buffer.from(this.buffer.subarray(offset, offset + len))
      if (maskBytes) for (let i = 0; i < payload.length; i++) payload[i] ^= maskBytes[i % 4]
      this.buffer = this.buffer.subarray(offset + len)
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      if (opcode === 9) this.frame(10, payload)
      else if (opcode === 8) {
        this.close()
        return
      } else if (opcode === 1 || opcode === 0) {
        this.fragments.push(payload)
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8')
          this.fragments = []
          for (const handler of this.handlers) handler(text)
        }
      }
    }
  }

  onClosed() {
    if (!this.open) return
    this.open = false
    for (const handler of this.closeHandlers) handler()
  }
}

// ---- the phone ------------------------------------------------------------------------------------------------------

const PHONE_TOOLS = [
  { name: 'notify', description: 'Show a notification on this phone', params: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } } }, group: 'notifications', readOnly: false },
  { name: 'ask_user', description: 'Ask the person on this phone, with buttons', params: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } } }, group: 'approval', readOnly: false },
  { name: 'browser_open', description: 'Open a page in this phone browser (test stub)', params: { type: 'object', properties: { url: { type: 'string' } } }, group: 'browser', readOnly: false },
]

function phoneFacts(name) {
  return { name, kind: 'phone', platform: 'android', appVersion: 'e2e', screen: { width: 412, height: 915 }, canOpenLinks: true, canReceiveFiles: true, fingerprint: '', urls: [] }
}

class Phone {
  constructor(state) {
    this.state = state
    this.ws = null
    this.brain = null
    this.seq = 0
    this.pending = new Map()
    this.events = []
    this.commands = []
    this.eventWaiters = new Set()
  }

  /** Connect to the first brain (in rank order) whose health says ready. */
  async connectBest(order = this.state.brains) {
    for (const brain of order) {
      const health = await this.health(brain)
      if (health?.ready === true) {
        await this.connect(brain)
        return brain
      }
      log(`brain ${brain.label} not ready (${health === null ? 'no answer' : 'ready false'})`)
    }
    throw new Error('No agents available: no brain answered ready')
  }

  async health(brain) {
    for (const url of brain.urls) {
      try {
        const res = await pinnedRequest(`${url}/v1/health`, brain.fp, { timeoutMs: 3000 })
        if (res.status === 200) return { ...json(res), url }
      } catch {
        // next address
      }
    }
    return null
  }

  async connect(brain) {
    this.close()
    let lastError = null
    for (const url of brain.urls) {
      try {
        const ws = await Ws.connect(url, brain.fp, this.state.pass)
        this.ws = ws
        this.brain = { ...brain, url }
        ws.onMessage((text) => this.onFrame(text))
        ws.onClose(() => {
          for (const [, p] of this.pending) p.reject(new Error('connection closed'))
          this.pending.clear()
        })
        ws.send(JSON.stringify({ type: 'hello', device: { ...phoneFacts(this.state.name), tools: PHONE_TOOLS } }))
        await sleep(200)
        return
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('no address answered')
  }

  close() {
    this.ws?.close()
    this.ws = null
  }

  call(method, ...callArgs) {
    if (this.ws === null || !this.ws.open) return Promise.reject(new Error('not connected'))
    const id = String(++this.seq)
    this.ws.send(JSON.stringify({ type: 'call', id, method, args: callArgs }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: no answer in 60 s`))
      }, 60_000)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
    })
  }

  onFrame(text) {
    let frame
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (frame.type === 'result') {
      const p = this.pending.get(String(frame.id))
      if (!p) return
      this.pending.delete(String(frame.id))
      if (frame.ok) p.resolve(frame.value)
      else p.reject(new Error(frame.error ?? 'failed'))
      return
    }
    if (frame.type !== 'event') return
    this.events.push({ name: frame.name, payload: frame.payload, at: Date.now() })
    if (frame.name === 'device.command') void this.onCommand(frame.payload)
    for (const waiter of this.eventWaiters) waiter()
  }

  /** What a phone does with a command: acks links and files, answers tools. */
  async onCommand(command) {
    this.commands.push(command)
    try {
      if (command.kind === 'tool') {
        const value = command.tool === 'notify' ? 'Shown' : command.tool === 'ask_user' ? (command.args?.options?.[0] ?? 'Yes') : command.tool === 'browser_open' ? `Opened ${command.args?.url ?? ''} (test stub)` : null
        if (value === null) await this.call('device.result', command.id, false, `no tool ${command.tool}`)
        else await this.call('device.result', command.id, true, value)
      } else await this.call('device.ack', command.id, true, '')
    } catch (error) {
      log(`answering ${command.kind} failed: ${error.message}`)
    }
  }

  async waitFor(check, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await check()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
      await sleep(1000)
    }
  }

  async rows(entity) {
    return (await this.call('data.list', entity)) ?? []
  }
}

// ---- pairing --------------------------------------------------------------------------------------------------------

function parseLink(link) {
  if (!link.startsWith('agent://pair?')) return null
  const q = new URLSearchParams(link.slice('agent://pair?'.length))
  return { urls: (q.get('u') ?? '').split(',').filter(Boolean), fp: q.get('fp') ?? '', code: q.get('c') ?? '', name: q.get('name') ?? '' }
}

async function pair() {
  if (existsSync(args.state) && args.code === '') {
    const saved = JSON.parse(readFileSync(args.state, 'utf8'))
    log(`using saved pairing ${saved.deviceId} from ${args.state}`)
    return saved
  }
  if (args.code === '') throw new Error('Pass --code (short code or agent://pair link), or a --state file from an earlier run.')
  const link = parseLink(args.code)
  const urls = link?.urls.length ? link.urls : args.brain.slice(0, 1)
  if (urls.length === 0) throw new Error('Pass --brain with the first brain address (or an agent://pair link).')
  const code = link?.code || args.code
  let fp = link?.fp ?? ''
  let answer = null
  let lastError = null
  for (const url of urls) {
    try {
      const res = await pinnedRequest(`${url}/v1/pair`, fp, { method: 'POST', body: { code, device: phoneFacts(args.name), wantRoles: ['screen'] } })
      if (fp === '') {
        fp = res.seenFp ?? ''
        console.log(`    trusted on first use: ${fp} (${fpWords(fp)})`)
      }
      if (res.status !== 200) throw new Error(`pairing refused: HTTP ${res.status} ${res.body.toString('utf8').slice(0, 200)}`)
      answer = json(res)
      answer.firstUrl = url
      break
    } catch (error) {
      lastError = error
    }
  }
  if (answer === null) throw lastError ?? new Error('pairing failed')
  const brains = (answer.brains ?? []).map((b) => ({ id: b.id, label: b.name, urls: b.urls ?? [], fp: b.fp ?? '', priority: b.priority ?? 0 }))
  if (!brains.some((b) => b.id === answer.node.id)) brains.unshift({ id: answer.node.id, label: answer.node.name, urls: [answer.firstUrl], fp, priority: -1 })
  const first = brains.find((b) => b.id === answer.node.id)
  if (first.fp === '') first.fp = fp
  if (!first.urls.includes(answer.firstUrl)) first.urls.unshift(answer.firstUrl)
  const state = { deviceId: answer.deviceId, pass: answer.pass, meshId: answer.meshId, name: args.name, brains }
  writeFileSync(args.state, JSON.stringify(state, null, 2), { mode: 0o600 })
  log(`paired as ${state.deviceId}; ${brains.length} brain(s) known`)
  return state
}

/** The ranked brain list: the --brain order wins (with the fingerprints pairing gave us), then any others. */
function ranked(state) {
  const list = []
  for (const [i, url] of args.brain.entries()) {
    const known = state.brains.find((b) => b.urls.includes(url))
    list.push({ ...(known ?? { id: `brain-${i + 1}`, label: `brain ${i + 1}`, fp: '' }), urls: [url, ...((known?.urls ?? []).filter((u) => u !== url))], index: i })
  }
  for (const b of state.brains) if (!list.some((x) => x.id === b.id)) list.push({ ...b, index: -1 })
  return list
}

function runHook(kind, brain) {
  const list = kind === 'stop' ? args.stopCmd : args.startCmd
  const cmd = brain.index >= 0 ? (list[brain.index] ?? '') : ''
  if (cmd === '') return false
  log(`${kind} ${brain.label}: running the --${kind}-cmd hook`)
  const out = spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: 120_000 })
  if (out.status !== 0) log(`hook exit ${out.status}: ${(out.stderr || out.stdout || '').trim().slice(0, 300)}`)
  return out.status === 0
}

// ---- helpers for checks -----------------------------------------------------------------------------------------

const metaOf = (row) => {
  try {
    return JSON.parse(row.meta ?? '{}')
  } catch {
    return {}
  }
}

async function replyContaining(phone, marker, timeoutMs) {
  return phone.waitFor(async () => {
    const rows = await phone.rows('chat_item').catch(() => [])
    return rows.find((r) => r.kind === 'agent' && typeof r.text === 'string' && r.text.includes(marker))
  }, timeoutMs, `a reply containing ${marker}`)
}

async function waitRunning(phone, chat, timeoutMs) {
  return phone.waitFor(async () => {
    const s = await (chat === undefined ? phone.call('chat.state') : phone.call('chat.state', chat)).catch(() => null)
    return s?.running === true
  }, timeoutMs, 'the turn to start')
}

const SECRET_SHAPES = /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,}|xox[abpr]-[A-Za-z0-9-]{10,}|[0-9a-f]{64})\b/

// ---- the checks ---------------------------------------------------------------------------------------------------

const results = []
function record(id, status, title, evidence) {
  results.push({ id, status, title })
  console.log(`${status.padEnd(4)} ${id}. ${title}`)
  for (const line of evidence) console.log(`       ${line}`)
}

async function check(id, title, body) {
  if (args.only !== null && !args.only.has(id)) return
  const evidence = []
  try {
    const status = await body(evidence)
    record(id, status ?? 'PASS', title, evidence)
  } catch (error) {
    evidence.push(`error: ${error.message}`)
    record(id, 'FAIL', title, evidence)
  }
}

async function main() {
  const state = await pair()
  const brains = ranked(state)
  const phone = new Phone(state)
  const first = await phone.connectBest(brains)
  console.log(`    connected to ${first.label} (${phone.brain.url}); this phone is ${state.deviceId}`)

  await check('a', 'chat round trip: chat.send, then the reply over RPC', async (ev) => {
    const marker = `e2e-a-${nonce()}`
    const started = Date.now()
    await phone.call('chat.send', `This is an automated link test. Reply with exactly this code and nothing else: ${marker}`)
    const reply = await replyContaining(phone, marker, TIMEOUT_MS)
    ev.push(`reply "${reply.text.slice(0, 80)}" in ${Math.round((Date.now() - started) / 100) / 10} s from ${phone.brain.label}`)
    const chatEvents = phone.events.filter((e) => e.name.includes('chat')).length
    ev.push(`chat events heard: ${chatEvents}`)
    const mine = (await phone.rows('chat_item')).find((r) => r.kind === 'user' && r.text.includes(marker))
    const origin = metaOf(mine ?? {}).origin
    ev.push(`message origin: ${origin ? `${origin.name} (${origin.kind})` : 'none'}`)
    if (!origin || origin.deviceId !== state.deviceId) return 'FAIL'
  })

  await check('b', 'data and bundle visible on this phone, no secret reaches it', async (ev) => {
    const seen = []
    const counts = {}
    for (const entity of ['memory', 'task', 'goal', 'trigger', 'project', 'device']) {
      const rows = await phone.rows(entity)
      counts[entity] = rows.length
      seen.push(JSON.stringify(rows))
    }
    const projects = await phone.rows('project')
    const withIcon = projects.filter((p) => p.icon && (typeof p.icon.glyph === 'string' || typeof p.icon.image === 'string'))
    const calls = {}
    for (const [label, method] of [['profiles', 'profiles.list'], ['learned apps', 'apps.learned'], ['apps', 'apps.status'], ['settings', 'settings.get']]) {
      try {
        const value = await phone.call(method)
        calls[label] = Array.isArray(value) ? value.length : value && typeof value === 'object' ? 'ok' : String(value)
        seen.push(JSON.stringify(value))
      } catch (error) {
        calls[label] = `error: ${error.message}`
      }
    }
    const bundleRes = await pinnedRequest(`${phone.brain.url}/v1/bundle`, phone.brain.fp, { headers: { Authorization: `Bearer ${state.pass}` } })
    const bundle = json(bundleRes)
    seen.push(bundleRes.body.toString('utf8'))
    ev.push(`rows: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`)
    ev.push(`projects with an icon: ${withIcon.length} of ${projects.length}`)
    ev.push(`rpc: ${Object.entries(calls).map(([k, v]) => `${k} ${v}`).join(', ')}`)
    ev.push(`GET /v1/bundle: HTTP ${bundleRes.status}, secrets ${bundle && 'secrets' in bundle ? 'PRESENT' : 'absent'}`)
    const leak = seen.join('\n').match(SECRET_SHAPES)
    ev.push(`secret-shaped values in everything this phone read: ${leak ? `FOUND (${leak[0].slice(0, 6)}...)` : 'none'}`)
    const settings = await phone.call('settings.get').catch(() => ({}))
    const keyish = Object.entries(settings ?? {}).filter(([k, v]) => /key|token|pass|secret/i.test(k) && typeof v === 'string' && v.length > 12)
    if (keyish.length > 0) ev.push(`settings fields that look like secrets: ${keyish.map(([k]) => k).join(', ')}`)
    if (bundleRes.status !== 200 || (bundle && 'secrets' in bundle) || leak || keyish.length > 0) return 'FAIL'
    if (projects.length > 0 && withIcon.length < projects.length) return 'FAIL'
    if (Object.values(calls).some((v) => String(v).startsWith('error'))) return 'FAIL'
  })

  await check('c', 'a turn that names a project shows the project agent row', async (ev) => {
    const projects = await phone.rows('project')
    const project = args.project ? projects.find((p) => p.name.toLowerCase() === args.project.toLowerCase()) : projects.find((p) => !p.hidden) ?? projects[0]
    if (!project) {
      ev.push('no project on the brain to name (create one, or pass --project)')
      return 'SKIP'
    }
    const marker = `e2e-c-${nonce()}`
    const before = new Set((await phone.rows('chat_item')).filter((r) => r.kind === 'helper').map((r) => r.id))
    await phone.call('chat.send', `Automated link test: start a chat in the "${project.name}" project (use project_chat_start) with the brief "Reply with ${marker} and stop." Then tell me it started.`)
    const row = await phone.waitFor(async () => {
      const rows = await phone.rows('chat_item')
      return rows.find((r) => r.kind === 'helper' && !before.has(r.id) && (JSON.stringify(metaOf(r)).includes(project.id) || JSON.stringify(metaOf(r)).includes(project.name)))
    }, TIMEOUT_MS, 'a helper row for the project agent').catch(async (error) => {
      const after = (await phone.rows('project')).find((p) => p.id === project.id)
      ev.push(`project chats before ${project.chats.length}, after ${after?.chats.length ?? '?'} (a project chat ${after && after.chats.length > project.chats.length ? 'WAS' : 'was not'} started)`)
      throw error
    })
    const meta = metaOf(row)
    ev.push(`helper row ${row.id}: label "${meta.label ?? ''}", state ${meta.state ?? '?'}, summary "${String(meta.summary ?? '').slice(0, 60)}"`)
    ev.push(`project ${project.name} icon: ${project.icon?.image ? 'picture' : project.icon?.glyph ?? 'none'} ${project.icon?.color ?? ''}`)
  })

  await check('d', 'an image from a local path on the brain loads through /v1/file', async (ev) => {
    if (!args.image) {
      ev.push('pass --image /absolute/path/on/the/brain.png to run this')
      return 'SKIP'
    }
    await phone.call('chat.send', `Automated link test, no reply needed beyond "ok": here is a picture on your computer: ${args.image}`)
    await sleep(2000)
    const res = await pinnedRequest(`${phone.brain.url}/v1/file?path=${encodeURIComponent(args.image)}`, phone.brain.fp, { headers: { Authorization: `Bearer ${state.pass}` }, timeoutMs: 30_000 })
    ev.push(`HTTP ${res.status}, ${res.headers['content-type'] ?? '?'}, ${res.body.length} bytes`)
    const noPass = await pinnedRequest(`${phone.brain.url}/v1/file?path=${encodeURIComponent(args.image)}`, phone.brain.fp)
    ev.push(`without the pass: HTTP ${noPass.status}`)
    if (res.status !== 200 || !String(res.headers['content-type'] ?? '').startsWith('image/') || res.body.length === 0 || noPass.status === 200) return 'FAIL'
  })

  await check('e', 'open_url and device tools from a turn reach this phone', async (ev) => {
    const marker = `e2e-e-${nonce()}`
    const url = `https://example.com/${marker}`
    const before = phone.commands.length
    await phone.call('chat.send', `Automated link test: use the open_url tool to open ${url} on my device, then use device_tool with device "best" and tool "notify" (title "${marker}", body "test"), then reply done.`)
    const opened = await phone.waitFor(() => phone.commands.slice(before).find((c) => c.kind === 'open_url' && String(c.url ?? '').includes(marker)), TIMEOUT_MS, 'a device.command open_url')
    ev.push(`device.command ${opened.id}: open_url ${opened.url} (acked)`)
    const notify = await phone.waitFor(() => phone.commands.slice(before).find((c) => c.kind === 'tool' && c.tool === 'notify'), TIMEOUT_MS, 'a device.command tool notify').catch((error) => {
      ev.push(`no tool command: ${error.message}`)
      return null
    })
    if (notify) ev.push(`device.command ${notify.id}: tool notify, args ${JSON.stringify(notify.args)}, deadline ${notify.deadlineMs} ms (answered with device.result)`)
    const devices = await phone.rows('device')
    const me = devices.find((d) => d.id === state.deviceId)
    ev.push(`this phone's tools on its device row: ${(me?.tools ?? []).map((t) => t.name).join(', ') || 'none'}`)
    if (!notify || !(me?.tools ?? []).length) return 'FAIL'
  })

  await check('f', 'failover: the next brain keeps a turn going when the first one stops', async (ev) => {
    if (brains.length < 2) {
      ev.push('needs two --brain flags (ranked) and a --stop-cmd for the first')
      return 'SKIP'
    }
    const top = await phone.connectBest(brains)
    if (!args.stopCmd[top.index]) {
      ev.push(`no --stop-cmd for ${top.label}`)
      return 'SKIP'
    }
    const marker = `e2e-f-${nonce()}`
    await phone.call('chat.send', `Automated link test: write a short paragraph (about 120 words) about lighthouses, then end with this code on its own line: ${marker}`)
    await waitRunning(phone, undefined, 30_000).catch(() => undefined)
    ev.push(`turn started on ${top.label}; stopping it now`)
    runHook('stop', top)
    try {
      await sleep(2000)
      const next = await phone.connectBest(brains.filter((b) => b.id !== top.id))
      ev.push(`phone moved to ${next.label} (answered by ${next.label})`)
      // The other brain takes the lease once its heartbeat is 45 s stale and the first brain fails health.
      const reply = await replyContaining(phone, marker, Math.max(TIMEOUT_MS, 120_000))
      const leases = (await phone.rows('turn_lease').catch(() => [])).filter((l) => l.attempt > 1)
      ev.push(`reply "${reply.text.slice(-40).trim()}" seen on ${next.label}`)
      if (leases.length > 0) ev.push(`lease: attempt ${leases.at(-1).attempt}, now on ${leases.at(-1).brainId}, ${leases.at(-1).status}`)
      const copies = (await phone.rows('chat_item')).filter((r) => r.kind === 'agent' && r.text.includes(marker)).length
      ev.push(`replies with the code: ${copies}`)
      if (copies < 1) return 'FAIL'
    } finally {
      runHook('start', top)
    }
  })

  await check('g', 'crash resume: the answering brain killed mid-turn, restarted, the turn completes exactly once', async (ev) => {
    const top = await phone.connectBest(brains)
    if (!args.stopCmd[top.index] || !args.startCmd[top.index]) {
      ev.push(`needs --stop-cmd and --start-cmd for ${top.label}`)
      return 'SKIP'
    }
    const marker = `e2e-g-${nonce()}`
    await phone.call('chat.send', `Automated link test: write a short paragraph (about 120 words) about rivers, then end with this code on its own line: ${marker}`)
    await waitRunning(phone, undefined, 30_000)
    ev.push(`turn running on ${top.label}; killing it`)
    runHook('stop', top)
    await sleep(3000)
    runHook('start', top)
    const back = await phone.waitFor(async () => ((await phone.health(top))?.ready ? top : null), 120_000, `${top.label} to come back`)
    await phone.connect(back)
    ev.push(`${top.label} is back; phone reconnected`)
    await replyContaining(phone, marker, TIMEOUT_MS)
    // Give a duplicate time to show, if there were going to be one.
    await sleep(15_000)
    const copies = (await phone.rows('chat_item')).filter((r) => r.kind === 'agent' && r.text.includes(marker))
    const users = (await phone.rows('chat_item')).filter((r) => r.kind === 'user' && r.text.includes(marker))
    const leases = (await phone.rows('turn_lease').catch(() => [])).filter((l) => users.some((u) => u.id === l.messageId))
    ev.push(`replies with the code: ${copies.length}; messages sent: ${users.length}`)
    for (const l of leases) ev.push(`lease ${l.id}: status ${l.status}, attempt ${l.attempt}, brain ${l.brainId}`)
    if (copies.length !== 1) return 'FAIL'
    if (leases.length > 0 && !leases.some((l) => l.attempt >= 2)) ev.push('note: the lease shows no resume (the turn may have finished before the kill)')
  })

  phone.close()
  const failed = results.filter((r) => r.status === 'FAIL').length
  const passed = results.filter((r) => r.status === 'PASS').length
  console.log(`\n${passed} passed, ${failed} failed, ${results.length - passed - failed} skipped`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`FAIL setup: ${error.message}`)
  process.exit(2)
})
