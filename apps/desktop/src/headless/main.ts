/**
 * agent-node: the agent runtime as a plain Node service, for servers and any computer without a screen.
 *
 *   agent-node start [--daemon] [--listen 127.0.0.1] [--port 7787]
 *   agent-node stop
 *   agent-node status
 *   agent-node pair '<agent://pair?...>'
 *   agent-node pair --url https://host:7787 --code ABCD-EFGH
 *   agent-node devices
 *
 * Common: --data-dir <dir> (or AGENT_DATA_DIR; default ~/.local/share/agent-node). Needs Node 22.13 or newer.
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AiAccountDraft, DeviceRow, PairingOfferInfo, ProviderId } from '@agent/core'

import { AccountStore } from '../main/accounts'
import { Secrets } from '../main/secrets'
import { SettingsStore } from '../main/settings'
import { FileKeyCipher } from './file-cipher'
import { loadIdentity } from '../main/devices/identity'
import { DEVICES_CHANNELS } from '../shared/devices-channels'
import { callControl, startControl, terminalQr } from './control'
import { headlessFacts, startHeadlessDevices } from './devices'
import { readConfig, writeConfig, type NodeConfig } from './node-config'
import { pair, parsePairLink, shortCodeTarget } from './pair'
import { pinnedJson } from './pinned'
import { startHeadlessRuntime } from './runtime'

declare const __AGENT_VERSION__: string | undefined

const HELP = `agent-node: your agent as a service

  agent-node start [--daemon] [--listen ADDR] [--port N]   run the agent and its node server
  agent-node stop                                          stop it (a running turn may finish first)
  agent-node status                                        is it running, and can it answer
  agent-node pair 'agent://pair?...'                       join your devices with a pairing link
  agent-node pair --url https://host:7787 --code ABCD-EFGH join with an address and short code
  agent-node offer                                         pair a phone or computer to THIS node (QR + code)
  agent-node devices                                       the paired devices (or the brains, when stopped)
  agent-node roles <id> brain,hands | move <id> up|down    who answers, in which order
  agent-node revoke <id>                                   take a device out
  agent-node config [--listen ADDR] [--port N] [--url U]   where it listens, and an address that reaches it
  agent-node account list | add claude | add codex          the AI it thinks with (a plan signed in on this machine)
  agent-node account add api --provider P < keyfile        ... or an API key, read from stdin
  agent-node ask "hello"                                   one turn, to check it answers (while stopped)

  --data-dir DIR   where it keeps its data (or AGENT_DATA_DIR; default ~/.local/share/agent-node)
`

interface Args {
  command: string
  positional: string[]
  flags: Map<string, string | true>
}

/** Flags that never take a value. */
const BARE_FLAGS = new Set(['--daemon', '--foreground', '--allow-http', '--no-qr'])

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq > 0) flags.set(arg.slice(2, eq), arg.slice(eq + 1))
      else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--') && !BARE_FLAGS.has(arg)) {
          flags.set(arg.slice(2), next)
          i++
        } else flags.set(arg.slice(2), true)
      }
    } else positional.push(arg)
  }
  return { command: positional.shift() ?? 'help', positional, flags }
}

function flag(args: Args, name: string): string {
  const value = args.flags.get(name)
  return typeof value === 'string' ? value : ''
}

function appDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

function version(): string {
  if (typeof __AGENT_VERSION__ === 'string' && __AGENT_VERSION__ !== '') return __AGENT_VERSION__
  for (const file of [join(appDir(), 'package.json'), join(appDir(), '..', 'package.json')]) {
    try {
      const v = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version
      if (typeof v === 'string') return v
    } catch {
      // Try the next place.
    }
  }
  return '0.0.0'
}

function dataDirOf(args: Args): string {
  const chosen = flag(args, 'data-dir') || process.env['AGENT_DATA_DIR']?.trim() || join(homedir(), '.local', 'share', 'agent-node')
  return resolve(chosen)
}

function pidFile(dataDir: string): string {
  return join(dataDir, 'agent-node.pid')
}

export function runningPid(dataDir: string): number | null {
  try {
    const pid = Number(readFileSync(pidFile(dataDir), 'utf8').trim())
    if (!Number.isInteger(pid) || pid <= 0) return null
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

function checkNode(): void {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 13)) {
    console.error(`agent-node needs Node 22.13 or newer (this is ${process.versions.node}).`)
    process.exit(2)
  }
}

function applyListenFlags(args: Args, config: NodeConfig, dataDir: string): void {
  let changed = false
  const listen = flag(args, 'listen')
  if (listen !== '') {
    config.listen = listen
    changed = true
  }
  const url = flag(args, 'url')
  if (url !== '') {
    const clean = url.replace(/\/+$/, '')
    if (!/^https:\/\//i.test(clean)) throw new Error('An address starts with https://')
    config.publicUrls = [...new Set([...config.publicUrls, clean])]
    changed = true
  }
  const port = Number(flag(args, 'port'))
  if (flag(args, 'port') !== '' && Number.isInteger(port) && port > 0 && port < 65536) {
    config.port = port
    changed = true
  }
  if (changed) writeConfig(dataDir, config)
}

async function start(args: Args): Promise<number> {
  const dataDir = dataDirOf(args)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const existing = runningPid(dataDir)
  if (existing !== null) {
    console.log(`Already running (pid ${existing}).`)
    return 0
  }
  const config = readConfig(dataDir)
  applyListenFlags(args, config, dataDir)

  if (args.flags.has('daemon')) {
    mkdirSync(join(dataDir, 'logs'), { recursive: true })
    const out = openSync(join(dataDir, 'logs', 'node.out'), 'a')
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'start', '--data-dir', dataDir], {
      detached: true,
      // A service never keeps the folder it was started from (it may be a temp folder that goes away).
      cwd: homedir(),
      stdio: ['ignore', out, out],
      env: process.env,
    })
    child.unref()
    closeSync(out)
    // Give it a moment to bind, so the person sees a real answer.
    // A busy machine can take a while to open the databases; give it a minute.
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 250))
      if (runningPid(dataDir) !== null) {
        console.log(`Started (pid ${runningPid(dataDir)}). Log: ${join(dataDir, 'logs')}`)
        return 0
      }
      if (child.exitCode !== null) break
    }
    console.error(`It did not start. See ${join(dataDir, 'logs', 'node.out')}.`)
    return 1
  }

  const runtime = await startHeadlessRuntime({ dataDir, appDir: appDir(), version: version() })
  let node
  try {
    node = await startHeadlessDevices(runtime, { name: config.name, version: version(), listen: config.listen, port: config.port, extraUrls: config.publicUrls })
  } catch (error) {
    console.error(`The node could not start: ${error instanceof Error ? error.message : String(error)}`)
    await runtime.stop(0)
    return 1
  }
  const state = node.status()
  if (!state.running) {
    console.error(`The node server could not listen on ${config.listen}:${config.port}: ${state.error}`)
    await node.stop()
    await runtime.stop(0)
    return 1
  }
  const control = await startControl(dataDir, runtime.ipc)
  writeFileSync(pidFile(dataDir), `${process.pid}\n`, { mode: 0o600 })
  runtime.logger.info('Node listening', { listen: config.listen, port: state.port })
  console.log(`agent-node ${version()} listening on https://${config.listen}:${state.port} (fingerprint ${state.fp})`)

  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    console.log(`${signal}: stopping${runtime.busy() ? ' after the running turn' : ''}...`)
    void (async () => {
      control.close()
      await node.stop().catch(() => undefined)
      await runtime.stop(20_000).catch(() => undefined)
      rmSync(pidFile(dataDir), { force: true })
      process.exit(0)
    })()
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('uncaughtException', (error) => runtime.logger.error('Uncaught exception', { message: error.message, stack: error.stack }))
  process.on('unhandledRejection', (reason) => runtime.logger.error('Unhandled promise rejection', { reason: String(reason) }))
  return await new Promise<number>(() => undefined)
}

async function stopCommand(args: Args): Promise<number> {
  const dataDir = dataDirOf(args)
  const pid = runningPid(dataDir)
  if (pid === null) {
    console.log('Not running.')
    return 0
  }
  process.kill(pid, 'SIGTERM')
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (runningPid(dataDir) === null) {
      console.log('Stopped.')
      return 0
    }
  }
  console.error(`Still stopping (pid ${pid}); a turn may be finishing.`)
  return 1
}

async function status(args: Args): Promise<number> {
  const dataDir = dataDirOf(args)
  const config = existsSync(join(dataDir, 'node.json')) ? readConfig(dataDir) : null
  const pid = runningPid(dataDir)
  console.log(`agent-node ${version()} (Node ${process.versions.node})`)
  console.log(`data: ${dataDir}`)
  if (config === null) {
    console.log('state: not set up yet (run: agent-node start)')
    return 0
  }
  const identity = loadIdentity(join(dataDir, 'devices'))
  console.log(`node: ${config.name} (${identity.nodeId})`)
  console.log(`mesh: ${config.meshId === '' ? 'not paired (its own mesh)' : config.meshId}`)
  console.log(`listen: https://${config.listen}:${config.port}`)
  if (pid === null) {
    console.log('state: stopped')
    return 0
  }
  try {
    const fp = loadIdentity(join(dataDir, 'devices')).fp
    const host = config.listen === '0.0.0.0' || config.listen === '::' ? '127.0.0.1' : config.listen
    const reply = await pinnedJson(`https://${host.includes(':') ? `[${host}]` : host}:${config.port}/v1/health`, { fp, timeoutMs: 3000 })
    const h = (reply.json ?? {}) as { ready?: boolean; busy?: boolean }
    console.log(`state: running (pid ${pid}), ${h.ready === true ? 'ready' : 'no AI account yet'}${h.busy === true ? ', working' : ''}`)
  } catch (error) {
    console.log(`state: running (pid ${pid}) but not answering: ${error instanceof Error ? error.message : String(error)}`)
  }
  return 0
}

async function pairCommand(args: Args): Promise<number> {
  const dataDir = dataDirOf(args)
  const link = args.positional[0] ?? ''
  const target = link !== '' ? parsePairLink(link) : shortCodeTarget(flag(args, 'url'), flag(args, 'code'))
  const config = readConfig(dataDir)
  const identity = loadIdentity(join(dataDir, 'devices'))
  const settings = new SettingsStore(join(dataDir, 'settings.json'))
  const secrets = new Secrets(join(dataDir, 'secrets'), new FileKeyCipher(join(dataDir, 'secrets.key')))
  const facts = headlessFacts(config.name, version(), config.publicUrls, identity.fp)
  const outcome = await pair(target, facts, config, dataDir, { dataDir, settings, secrets })
  console.log(`Paired with ${outcome.url} as ${outcome.deviceId} (mesh ${outcome.meshId}).`)
  if (target.fp === '') console.log(`Its certificate fingerprint is ${outcome.fp}. Check it matches the one on that device.`)
  if (outcome.bundle !== null) {
    console.log(`Took in ${outcome.bundle.settings} settings and ${outcome.bundle.secrets} keys.`)
  } else console.log(`Paired, but the settings and keys did not come over yet: ${outcome.bundleError}`)
  if (runningPid(dataDir) !== null) console.log('Restart it to use them: agent-node stop && agent-node start --daemon')
  return 0
}

function stores(dataDir: string): { settings: SettingsStore; secrets: Secrets; accounts: AccountStore } {
  const settings = new SettingsStore(join(dataDir, 'settings.json'))
  const secrets = new Secrets(join(dataDir, 'secrets'), new FileKeyCipher(join(dataDir, 'secrets.key')))
  return { settings, secrets, accounts: new AccountStore(settings, secrets) }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}

/** AI accounts on a node set up by hand (a server that is not paired). Keys come on stdin, never on the command line. */
async function accountCommand(args: Args): Promise<number> {
  const dataDir = dataDirOf(args)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const { settings, accounts } = stores(dataDir)
  const action = args.positional[0] ?? 'list'
  if (action === 'list') {
    const main = settings.get().ai.main.account
    for (const a of accounts.all()) {
      console.log(`${a.id}  ${a.label}  ${a.kind}${a.provider === undefined ? '' : `/${a.provider}`}  ${a.kind === 'api' ? (a.hasKey ? 'key saved' : 'no key') : 'plan'}${a.id === main ? '  (main)' : ''}`)
    }
    return 0
  }
  if (action === 'remove') {
    accounts.remove(args.positional[1] ?? '')
    console.log('Removed.')
    return 0
  }
  if (action !== 'add') {
    console.error('Use: agent-node account list | add claude | add codex | add api --provider P [--base-url U] [--model M] < keyfile | remove ID')
    return 1
  }
  const kind = args.positional[1] ?? ''
  if (kind !== 'claude' && kind !== 'codex' && kind !== 'api') {
    console.error('Add which? claude, codex or api.')
    return 1
  }
  const draft: AiAccountDraft = { kind }
  if (flag(args, 'label') !== '') draft.label = flag(args, 'label')
  if (flag(args, 'model') !== '') draft.model = flag(args, 'model')
  let key = ''
  if (kind === 'api') {
    draft.provider = (flag(args, 'provider') || 'anthropic') as ProviderId
    if (flag(args, 'base-url') !== '') draft.baseUrl = flag(args, 'base-url')
    // Plain http only when asked for (a model server on this machine or a private network).
    if (args.flags.has('allow-http')) draft.allowHttp = true
    key = await readStdin()
    if (key === '') {
      console.error('Pipe the API key in on stdin, e.g. agent-node account add api --provider openai < key.txt')
      return 1
    }
  }
  const account = accounts.add(draft)
  if (key !== '') accounts.setKey(account.id, key)
  // The new account answers unless the person already chose one that can.
  const main = settings.get().ai.main.account
  const current = accounts.all().find((a) => a.id === main)
  if (current === undefined || (current.kind === 'api' && !current.hasKey)) {
    settings.save({ ai: { ...settings.get().ai, main: { account: account.id, model: '' } } })
  }
  console.log(`Added ${account.label} (${account.id}).${runningPid(dataDir) === null ? '' : ' Restart the node to use it.'}`)
  return 0
}

/** One turn in this process, printed as plain text. For checking a node by hand; refuses while the service runs. */
async function ask(args: Args): Promise<number> {
  const dataDir = dataDirOf(args)
  const text = args.positional.join(' ').trim()
  if (text === '') {
    console.error('Say what to ask: agent-node ask "hello"')
    return 1
  }
  if (runningPid(dataDir) !== null) {
    console.error('The node is running on this data folder; ask from a paired device, or stop it first.')
    return 1
  }
  const runtime = await startHeadlessRuntime({ dataDir, appDir: appDir(), version: version(), quiet: true })
  try {
    const before = new Set((await runtime.store.list('chat_item')).map((row) => row.id))
    await runtime.runner.send(text)
    const rows = (await runtime.store.list('chat_item')).filter((row) => !before.has(row.id) && row.kind !== 'user')
    for (const row of rows) if (row.text.trim() !== '') console.log(row.kind === 'agent' ? row.text : `[${row.kind}] ${row.text}`)
    return rows.some((row) => row.kind === 'agent' && row.text.trim() !== '') ? 0 : 1
  } finally {
    await runtime.stop(0)
  }
}

async function devices(args: Args): Promise<number> {
  const dataDir = dataDirOf(args)
  if (runningPid(dataDir) !== null) {
    const rows = (await callControl(dataDir, DEVICES_CHANNELS.list)) as DeviceRow[]
    for (const row of rows) {
      const state = row.revoked ? 'revoked' : row.roles.join('+')
      console.log(`${row.id}  ${row.name}  ${row.kind}/${row.platform}  ${state}${row.roles.includes('brain') ? `  priority ${row.priority}` : ''}`)
    }
    return 0
  }
  const config = readConfig(dataDir)
  if (config.brains.length === 0) {
    console.log('Not running, and not paired with any other device yet.')
    return 0
  }
  console.log('Not running. The brains it paired with:')
  for (const brain of [...config.brains].sort((a, b) => a.priority - b.priority)) {
    console.log(`${brain.priority}  ${brain.name || brain.id}  ${brain.urls.join(' ')}`)
  }
  return 0
}

/** "Add a device" from a terminal: a pairing link, its short code and a QR to scan, valid 10 minutes. */
async function offer(args: Args): Promise<number> {
  const dataDir = dataDirOf(args)
  if (runningPid(dataDir) === null) {
    console.error('Start it first: agent-node start --daemon')
    return 1
  }
  const made = (await callControl(dataDir, DEVICES_CHANNELS.offer)) as PairingOfferInfo
  if (!args.flags.has('no-qr')) console.log(`${terminalQr(made.qr)}\n`)
  console.log(`Pairing link: ${made.uri}`)
  console.log(`Short code:   ${made.shortCode}   (with the address ${made.urls[0] ?? 'of this node'})`)
  console.log(`Valid until:  ${new Date(made.expiresAt).toLocaleTimeString()}`)
  if (made.urls.length === 0) console.log('No address is advertised: add one with agent-node config --url https://<address>:<port>')
  return 0
}

async function deviceAction(args: Args, action: 'revoke' | 'roles' | 'move'): Promise<number> {
  const dataDir = dataDirOf(args)
  const id = args.positional[0] ?? ''
  if (id === '') {
    console.error(`Which device? agent-node ${action} <id> (agent-node devices lists them)`)
    return 1
  }
  if (action === 'revoke') await callControl(dataDir, DEVICES_CHANNELS.revoke, [id])
  if (action === 'roles') await callControl(dataDir, DEVICES_CHANNELS.setRoles, [id, (args.positional[1] ?? '').split(',').filter((r) => r !== '')])
  if (action === 'move') await callControl(dataDir, DEVICES_CHANNELS.move, [id, args.positional[1] === 'up' ? 'up' : 'down'])
  console.log('Done.')
  return 0
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  switch (args.command) {
    case 'start':
      checkNode()
      return start(args)
    case 'stop':
      return stopCommand(args)
    case 'status':
      return status(args)
    case 'pair':
      checkNode()
      return pairCommand(args)
    case 'devices':
      return devices(args)
    case 'offer':
      return offer(args)
    case 'revoke':
      return deviceAction(args, 'revoke')
    case 'roles':
      return deviceAction(args, 'roles')
    case 'move':
      return deviceAction(args, 'move')
    case 'account':
      checkNode()
      return accountCommand(args)
    case 'ask':
      checkNode()
      return ask(args)
    case 'config': {
      const dataDir = dataDirOf(args)
      const config = readConfig(dataDir)
      applyListenFlags(args, config, dataDir)
      console.log(`listen: https://${config.listen}:${config.port}; addresses: ${config.publicUrls.join(' ') || '(none)'} (takes effect on the next start)`)
      return 0
    }
    case 'version':
    case '--version':
      console.log(version())
      return 0
    default:
      console.log(HELP)
      return args.command === 'help' || args.command === '--help' ? 0 : 1
  }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    },
  )
}
