/**
 * Proof rig for the 12 Nov 2026 phone failover errors. Skipped unless PROOF_DIR is set.
 *
 * Real agent-node processes (own data folders, own ports, 127.0.0.1) and a scripted phone that does what the phone app
 * does: probes /v1/health in rank order, takes the first READY brain, sends chat.sendOnce with one id, holds the
 * message while nobody can answer, and reads the answer from the brain's chat rows.
 *
 *   PROOF_DIR=/tmp/proof OLD_BUNDLE=/path/old/agent-node.mjs NEW_BUNDLE=/path/new/agent-node.mjs \
 *   NODE_BIN=/path/node CLAUDE_BIN=/path/claude npx vitest run apps/desktop/test/phone-failover-proof.test.ts
 *
 * Every line it logs goes to PROOF_DIR/proof.log.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { connectRpc, pinnedRequest, type RpcClient } from './devices-client'

const DIR = process.env['PROOF_DIR'] ?? ''
const OLD = process.env['OLD_BUNDLE'] ?? ''
const NEW = process.env['NEW_BUNDLE'] ?? ''
const NODE = process.env['NODE_BIN'] ?? process.execPath
const CLAUDE = process.env['CLAUDE_BIN'] ?? ''

const PHONE = { name: 'Scripted A35', kind: 'phone', platform: 'android', appVersion: '0.15.57', screen: { width: 412, height: 915 }, canOpenLinks: true, canReceiveFiles: true, fingerprint: '', urls: [] }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const started = Date.now()
function log(line: string): void {
  const text = `[+${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${line}`
  appendFileSync(join(DIR, 'proof.log'), `${text}\n`)
  console.log(text)
}

interface TestNode {
  name: string
  base: string
  fp: string
  pass: string
  child: ChildProcess
  stop: () => Promise<void>
}

const alive: TestNode[] = []

function env(data: string, claudeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_DATA_DIR: data,
    CLAUDE_CONFIG_DIR: claudeDir,
    AGENT_CLAUDE_PATH: CLAUDE,
    PATH: `${dirname(NODE)}:${process.env['PATH'] ?? ''}`,
  }
}

/** A dead login: the file is there, the session ran out and cannot be renewed. */
function deadLogin(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, '.credentials.json')
  writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'dead', refreshToken: 'dead', expiresAt: 1, scopes: ['user:inference'], subscriptionType: 'max' } }), { mode: 0o600 })
  return file
}

async function startNode(name: string, bundle: string, claudeDir: string, port: number): Promise<TestNode> {
  const data = join(DIR, `data-${name}`)
  rmSync(data, { recursive: true, force: true })
  mkdirSync(data, { recursive: true, mode: 0o700 })
  const e = env(data, claudeDir)
  execFileSync(NODE, [bundle, 'account', 'add', 'claude'], { env: e, stdio: 'pipe' })
  const child = spawn(NODE, [bundle, 'start', '--foreground', '--listen', '127.0.0.1', '--port', String(port)], { env: e, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout?.on('data', (c: Buffer) => (out += c.toString()))
  child.stderr?.on('data', (c: Buffer) => (out += c.toString()))
  const t0 = Date.now()
  while (!/fingerprint (\S+)\)/.test(out)) {
    if (Date.now() - t0 > 60_000) throw new Error(`${name} did not start: ${out.slice(-400)}`)
    await sleep(200)
  }
  const fp = /fingerprint (\S+)\)/.exec(out)?.[1] ?? ''
  const base = `https://127.0.0.1:${port}`
  const offer = execFileSync(NODE, [bundle, 'offer', '--no-qr'], { env: e, encoding: 'utf8' })
  const code = /Short code:\s+(\S+)/.exec(offer)?.[1]?.replace('-', '') ?? ''
  const pair = await pinnedRequest(`${base}/v1/pair`, fp, { method: 'POST', body: { code, device: PHONE, wantRoles: ['screen'] } })
  if (pair.status !== 200) throw new Error(`pairing ${name}: ${pair.status}`)
  const { pass } = pair.json() as { pass: string }
  const node: TestNode = {
    name,
    base,
    fp,
    pass,
    child,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        const t = Date.now()
        while (child.exitCode === null && child.signalCode === null && Date.now() - t < 15_000) await sleep(100)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
    },
  }
  alive.push(node)
  log(`${name}: started (${bundle === OLD ? 'OLD 0.2.116 code' : 'NEW code'}) on ${base}, paired`)
  return node
}

async function health(node: TestNode): Promise<{ ready: boolean; version: string } | null> {
  try {
    const reply = await Promise.race([pinnedRequest(`${node.base}/v1/health`, node.fp), sleep(3000).then(() => null)])
    if (reply === null) return null
    const json = reply.json() as { ready?: boolean; version?: string }
    return { ready: json.ready === true, version: String(json.version) }
  } catch {
    return null
  }
}

interface Row {
  id: string
  kind: string
  text: string
}

async function rows(rpc: RpcClient): Promise<Row[]> {
  return (await rpc.call('data.list', 'chat_item')) as Row[]
}

/**
 * The phone's send: brains in rank order, the first that answers /v1/health with ready, chat.sendOnce with one id
 * (6 s to answer), the same id on the next brain, and the words held while nobody can answer.
 */
async function phoneSend(brains: TestNode[], text: string, holdMs: number): Promise<{ brain: TestNode; rpc: RpcClient; sendId: string; tries: string[] }> {
  const sendId = randomUUID().replace(/-/g, '').slice(0, 24)
  const tries: string[] = []
  const t0 = Date.now()
  let lastSummary = ''
  while (Date.now() - t0 < holdMs) {
    const summary: string[] = []
    for (const brain of brains) {
      const h = await health(brain)
      if (h === null) {
        summary.push(`${brain.name}: not answering`)
        continue
      }
      if (!h.ready) {
        summary.push(`${brain.name}: up but NOT READY, skipped`)
        continue
      }
      let rpc: RpcClient
      try {
        rpc = await connectRpc(brain.base, brain.fp, brain.pass, PHONE)
      } catch (error) {
        summary.push(`${brain.name}: link failed (${String(error)})`)
        continue
      }
      const answer = (await Promise.race([rpc.call('chat.sendOnce', { sendId, sentAt: Date.now(), fresh: false, text }), sleep(6000).then(() => null)])) as { accepted?: boolean } | null
      if (answer?.accepted === true) {
        tries.push(`${brain.name} accepted`)
        log(`phone: "${text}" taken by ${brain.name} (sendId ${sendId}) after ${((Date.now() - t0) / 1000).toFixed(1)} s`)
        return { brain, rpc, sendId, tries }
      }
      rpc.close()
      summary.push(`${brain.name}: did not take it`)
    }
    const line = summary.join('; ')
    if (line !== lastSummary) {
      log(`phone: holding "${text}": ${line}`)
      lastSummary = line
    }
    tries.push(line)
    await sleep(1000)
  }
  throw new Error('None of your computers answered')
}

/** What the person would see after the message: every row that is not the message itself, once the turn has ended. */
async function answerOf(sent: { rpc: RpcClient; sendId: string }, ms = 150_000): Promise<Row[]> {
  const t0 = Date.now()
  let seen: Row[] = []
  const after = async (): Promise<Row[]> => {
    const all = await rows(sent.rpc)
    const at = all.findIndex((r) => r.id === `send-${sent.sendId}`)
    return at < 0 ? [] : all.slice(at + 1).filter((r) => r.kind !== 'user' && r.text.trim() !== '')
  }
  while (Date.now() - t0 < ms) {
    seen = await after()
    if (seen.some((r) => r.kind === 'agent' || r.kind === 'error' || /not signed in/i.test(r.text))) {
      await sleep(1500)
      return after()
    }
    await sleep(1500)
  }
  return seen
}

const describeIf = DIR === '' ? describe.skip : describe

describeIf('phone failover proof', () => {
  afterAll(async () => {
    for (const node of alive) await node.stop()
  })

  it('SETUP', () => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(join(DIR, 'proof.log'), '')
    log(`old bundle ${OLD}`)
    log(`new bundle ${NEW}`)
    expect(CLAUDE).not.toBe('')
  })

  it('S1 before the fix: a node with a dead Claude login says ready, takes the phone message, and answers with the error', async () => {
    const dead = join(DIR, 'claude-dead-1')
    deadLogin(dead)
    const old = await startNode('old-dead', OLD, dead, 7811)
    const h = await health(old)
    log(`S1 old node /v1/health -> ready=${h?.ready} version=${h?.version}`)
    expect(h?.ready).toBe(true)
    const sent = await phoneSend([old], 'Reply with the single word OK', 20_000)
    const shown = await answerOf(sent)
    for (const r of shown) log(`S1 what the phone shows: [${r.kind}] ${r.text.slice(0, 160)}`)
    expect(shown.some((r) => /not signed in/i.test(r.text))).toBe(true)
    sent.rpc.close()
    await old.stop()
  }, 240_000)

  it('S2 after the fix: the same dead login is NOT READY, the phone holds the message, and sends it once when the login is back', async () => {
    const dead = join(DIR, 'claude-dead-2')
    const file = deadLogin(dead)
    const node = await startNode('new-dead', NEW, dead, 7812)
    const h = await health(node)
    log(`S2 new node /v1/health -> ready=${h?.ready} version=${h?.version}`)
    expect(h?.ready).toBe(false)
    // The person's computer is still away. Eight seconds in, the login is put back (the file is replaced with the live one).
    setTimeout(() => {
      copyFileSync(join(homedir(), '.claude', '.credentials.json'), file)
      log('S2 login put back (credentials replaced), as when someone signs in again')
    }, 8000)
    const sent = await phoneSend([node], 'Reply with the single word OK', 60_000)
    const shown = await answerOf(sent)
    for (const r of shown) log(`S2 what the phone shows: [${r.kind}] ${r.text.slice(0, 160)}`)
    const all = await rows(sent.rpc)
    const userRows = all.filter((r) => r.id === `send-${sent.sendId}`)
    log(`S2 rows for that send id: ${userRows.length}; replies: ${shown.filter((r) => r.kind === 'agent').length}`)
    expect(userRows.length).toBe(1)
    expect(shown.some((r) => /not signed in/i.test(r.text))).toBe(false)
    expect(shown.filter((r) => r.kind === 'agent').length).toBeGreaterThan(0)
    sent.rpc.close()
    await node.stop()
  }, 300_000)

  it('S3 the computer drops: a ready brain answers at once, and a brain without a working plan is skipped, no error', async () => {
    const dead = join(DIR, 'claude-dead-3')
    deadLogin(dead)
    const pc = await startNode('test-pc', NEW, join(homedir(), '.claude'), 7813)
    const srvDead = await startNode('server-dead-plan', NEW, dead, 7814)
    const srv = await startNode('server-claude', NEW, join(homedir(), '.claude'), 7815)
    log(`S3 health: pc=${JSON.stringify(await health(pc))} dead-plan=${JSON.stringify(await health(srvDead))} server=${JSON.stringify(await health(srv))}`)
    // Rank: PC, then a server whose plan is signed out, then a server that works.
    const order = [pc, srvDead, srv]
    const first = await phoneSend(order, 'Reply with the single word ONE', 30_000)
    expect(first.brain.name).toBe('test-pc')
    const a1 = await answerOf(first)
    for (const r of a1) log(`S3 message 1 shown: [${r.kind}] ${r.text.slice(0, 120)}`)
    first.rpc.close()
    // The link to the PC is cut (the test PC process is stopped, by its own handle).
    log(`S3 cutting the test PC (pid ${pc.child.pid})`)
    await pc.stop()
    const second = await phoneSend(order, 'Reply with the single word TWO', 30_000)
    log(`S3 message 2 went to ${second.brain.name}; tries: ${second.tries.join(' | ') || 'first try'}`)
    expect(second.brain.name).toBe('server-claude')
    const a2 = await answerOf(second)
    for (const r of a2) log(`S3 message 2 shown: [${r.kind}] ${r.text.slice(0, 120)}`)
    expect(a2.some((r) => /not signed in|None of your computers/i.test(r.text))).toBe(false)
    expect(a2.some((r) => r.kind === 'agent')).toBe(true)
    second.rpc.close()
    await srv.stop()
    await srvDead.stop()
  }, 400_000)
})
