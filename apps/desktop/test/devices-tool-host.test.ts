/**
 * Protocol s11 on the desktop node, and the Windows Firewall step. The firewall part never runs netsh for real and
 * never shows a UAC prompt: it checks the parsing, the state, and the exact command the one prompt would run.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { Tool, ToolContext } from '@agent/core'

import { Store } from '../src/main/db'
import { DEFAULT_SHARE, DeviceToolHost, groupOf, resultValue, toolCommand, type ShareGroup } from '../src/main/devices/device-tool-host'
import { RULE_NAME, VPN_REMOTE, WindowsFirewall, allowScript, elevateArgs, firewallState, parseFirewallRules } from '../src/main/devices/firewall'
import { HandlerRegistry } from '../src/main/devices/registry'
import { DevicesService } from '../src/main/devices/service'
import type { DeviceToolResult } from '../src/main/devices/types'
import { connectRpc, pinnedRequest } from './devices-client'

const dirs: string[] = []
const services: DevicesService[] = []
const stores: Store[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-s11-'))
  dirs.push(dir)
  return dir
}

const noCtx = (signal: AbortSignal): ToolContext => ({
  agentLabel: 'another device',
  owner: 'device',
  activity: async () => 0,
  updateActivity: async () => undefined,
  ask: async () => 'Yes',
  approve: async () => true,
  notify: async () => undefined,
  signal,
})

function fakeTool(name: string, run: Tool['run']): Tool {
  return { spec: { name, description: `${name} for tests`, schema: { type: 'object', properties: {} } }, run }
}

// ---- the firewall (Windows) ----

const NETSH = `
Rule Name:                            Electron
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Public
Grouping:
LocalIP:                              Any
RemoteIP:                             Any
Protocol:                             TCP
LocalPort:                            Any
RemotePort:                           Any
Edge traversal:                       No
Program:                              C:\\Apps\\Agent\\Agent.exe
InterfaceTypes:                       Any
Security:                             NotRequired
Rule source:                          Local Setting
Action:                               Block

Rule Name:                            Some other app
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Private
Protocol:                             TCP
LocalPort:                            8080
Program:                              C:\\Other\\other.exe
Action:                               Allow
Ok.
`

describe('Windows Firewall step', () => {
  const program = 'C:\\Apps\\Agent\\Agent.exe'

  it('reads netsh rules and sees that a Block rule for the app keeps devices out', () => {
    const rules = parseFirewallRules(NETSH)
    expect(rules).toHaveLength(2)
    expect(rules[0]).toMatchObject({ name: 'Electron', enabled: true, direction: 'in', action: 'block', program, localPort: 'Any' })
    expect(firewallState(rules, program, 7787)).toBe('blocked')
    // The path compares without case, as Windows does.
    expect(firewallState(rules, program.toLowerCase(), 7787)).toBe('blocked')
  })

  it('says allowed only when Private, Domain AND Public are covered (a VPN adapter is often Public)', () => {
    const rule = (name: string, profiles: string, extra = `Program: ${program}`): string =>
      `Rule Name: ${name}\nEnabled: Yes\nDirection: In\nProfiles: ${profiles}\n${extra}\nRemoteIP: Any\nAction: Allow\n\n`
    expect(firewallState([], program, 7787)).toBe('missing')
    // An older Private-only rule (or the one Windows makes when Allow is clicked on a private network) is not enough.
    expect(firewallState(parseFirewallRules(rule(RULE_NAME, 'Domain,Private')), program, 7787)).toBe('missing')
    const both = parseFirewallRules(rule(RULE_NAME, 'Domain,Private') + rule(`${RULE_NAME} (VPN)`, 'Public'))
    expect(firewallState(both, program, 7787)).toBe('allowed')
    expect(both[1]?.remoteIp).toBe('Any')
    expect(firewallState(parseFirewallRules(rule('x', 'Any')), program, 7787)).toBe('allowed')
    const ports = parseFirewallRules(rule(`${RULE_NAME} (port 7787)`, 'Domain,Private', 'LocalPort: 7787\nProgram: Any') + rule(`${RULE_NAME} (port 7787, VPN)`, 'Public', 'LocalPort: 7787\nProgram: Any'))
    expect(firewallState(ports, program, 7787)).toBe('allowed')
    expect(firewallState(ports, program, 7797)).toBe('missing')
    const disabled = parseFirewallRules(`Rule Name: x\nEnabled: No\nDirection: In\nProfiles: Any\nProgram: ${program}\nAction: Allow\n`)
    expect(firewallState(disabled, program, 7787)).toBe('missing')
  })

  it('builds ONE elevated command that clears the app\'s Block rules and allows the app and the port', () => {
    const path = "C:\\Users\\Sam O'Neil\\Apps\\Agent.exe"
    const script = allowScript(path, 7787)
    expect(script).toContain("Get-NetFirewallApplicationFilter -Program 'C:\\Users\\Sam O''Neil\\Apps\\Agent.exe'")
    expect(script).toContain("Remove-NetFirewallRule")
    const exe = "'C:\\Users\\Sam O''Neil\\Apps\\Agent.exe'"
    // Private and Domain from anywhere; Public only from this subnet and the VPN ranges, never the whole internet.
    expect(VPN_REMOTE).toBe('LocalSubnet,100.64.0.0/10,fd7a:115c:a1e0::/48')
    const adds = script.split('\n').filter((line) => line.startsWith('netsh advfirewall firewall add rule'))
    expect(adds).toEqual([
      `netsh advfirewall firewall add rule name='${RULE_NAME}' dir=in action=allow program=${exe} enable=yes profile=private,domain`,
      `netsh advfirewall firewall add rule name='${RULE_NAME} (VPN)' dir=in action=allow program=${exe} enable=yes profile=public remoteip=LocalSubnet,100.64.0.0/10,fd7a:115c:a1e0::/48`,
      `netsh advfirewall firewall add rule name='${RULE_NAME} (port 7787)' dir=in action=allow protocol=TCP localport=7787 enable=yes profile=private,domain`,
      `netsh advfirewall firewall add rule name='${RULE_NAME} (port 7787, VPN)' dir=in action=allow protocol=TCP localport=7787 enable=yes profile=public remoteip=LocalSubnet,100.64.0.0/10,fd7a:115c:a1e0::/48`,
    ])
    // Every rule it adds is deleted first, so running it twice leaves one of each.
    for (const name of [RULE_NAME, `${RULE_NAME} (VPN)`, `${RULE_NAME} (port 7787)`, `${RULE_NAME} (port 7787, VPN)`]) {
      expect(script).toContain(`netsh advfirewall firewall delete rule name='${name}' | Out-Null`)
    }
    // No rule anywhere opens Public to any address.
    expect(adds.filter((line) => line.includes('profile=public') && !line.includes('remoteip='))).toEqual([])
    const args = elevateArgs(path, 7787)
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    const outer = args[3] ?? ''
    expect(outer).toMatch(/^Start-Process -FilePath powershell\.exe -Verb RunAs -Wait /)
    // The elevated part travels base64 (UTF-16LE), so the path is never quoted through two shells.
    const encoded = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(outer)?.[1] ?? ''
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(script)
  })

  it('checks with netsh (no elevation) and needs nothing off Windows', async () => {
    const calls: string[][] = []
    const win = new WindowsFirewall({ platform: 'win32', program, run: async (file, args) => (calls.push([file, ...args]), NETSH) })
    expect(await win.state(7787)).toBe('blocked')
    expect(calls[0]).toEqual(['netsh', 'advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in', 'verbose'])
    const broken = new WindowsFirewall({ platform: 'win32', program, run: async () => Promise.reject(new Error('no netsh')) })
    expect(await broken.state(7787)).toBe('unknown')
    const linux = new WindowsFirewall({ platform: 'linux', program: '/usr/bin/agent', run: async () => { throw new Error('must not run') } })
    expect(linux.needed).toBe(false)
    expect(await linux.state(7787)).toBe('not-needed')
  })
})

// ---- the tool host ----

describe('this node\'s tools for other devices', () => {
  it('sorts the app\'s tools into the groups a person can switch off', () => {
    expect(groupOf('browser_open')).toBe('browser')
    expect(groupOf('notify_user')).toBe('notifications')
    expect(groupOf('ask_user')).toBe('approval')
    expect(groupOf('request_approval')).toBe('approval')
    expect(groupOf('files_read')).toBe('files')
    expect(groupOf('shell_run')).toBe('shell')
    expect(groupOf('memory_save')).toBeNull()
    expect(DEFAULT_SHARE).toEqual({ browser: true, files: true, notifications: true, approval: true, shell: false })
  })

  it('offers only switched-on groups, runs a command and answers with images inline', async () => {
    const dir = tempDir()
    const shot = join(dir, 'page.png')
    writeFileSync(shot, Buffer.from([137, 80, 78, 71]))
    let shared: Record<ShareGroup, boolean> = { ...DEFAULT_SHARE }
    const host = new DeviceToolHost({
      tools: () => [
        fakeTool('browser_look', async () => `Here is the page:\n[[image:${shot}]]`),
        fakeTool('shell_run', async () => 'ran'),
        fakeTool('memory_save', async () => 'saved'),
        fakeTool('ask_user', async (_input, ctx) => (await ctx.ask('Go?', ['Yes', 'No'])) ?? 'no answer'),
      ],
      context: (signal) => noCtx(signal),
      shared: () => shared,
      inbox: join(dir, 'inbox'),
    })
    const names = host.catalogue().map((tool) => tool.name)
    expect(names).toEqual(['browser_look', 'ask_user', 'file_send', 'file_receive'])
    expect(host.catalogue().find((t) => t.name === 'browser_look')).toMatchObject({ group: 'browser', readOnly: true })

    const look = await host.run({ kind: 'tool', id: 'c1', tool: 'browser_look', args: {}, chatId: 'main', deadlineMs: 5000 })
    expect(look).toEqual({ ok: true, value: { text: 'Here is the page:', images: [{ type: 'image', mime: 'image/png', data: Buffer.from([137, 80, 78, 71]).toString('base64') }] } })
    expect(await host.run({ kind: 'tool', id: 'c2', tool: 'ask_user', args: {}, chatId: '', deadlineMs: 0 })).toEqual({ ok: true, value: { text: 'Yes' } })
    expect(await host.run({ kind: 'tool', id: 'c3', tool: 'shell_run', args: {}, chatId: '', deadlineMs: 0 })).toEqual({ ok: false, error: 'shell_run is not shared on this device.' })
    expect(await host.run({ kind: 'tool', id: 'c4', tool: 'memory_save', args: {}, chatId: '', deadlineMs: 0 })).toMatchObject({ ok: false })
    expect(await host.run({ kind: 'nope' })).toEqual({ ok: false, error: 'That is not a tool command.' })

    shared = { ...shared, shell: true, browser: false }
    expect(host.catalogue().map((t) => t.name)).toEqual(['shell_run', 'ask_user', 'file_send', 'file_receive'])
    expect(await host.run({ kind: 'tool', id: 'c5', tool: 'shell_run', args: {}, chatId: '', deadlineMs: 0 })).toEqual({ ok: true, value: { text: 'ran' } })
  })

  it('stops a tool at its deadline', async () => {
    const host = new DeviceToolHost({
      tools: () => [fakeTool('notify_user', () => new Promise(() => undefined))],
      context: (signal) => noCtx(signal),
      shared: () => DEFAULT_SHARE,
      inbox: tempDir(),
    })
    const started = Date.now()
    const result = await host.run({ kind: 'tool', id: 'slow', tool: 'notify_user', args: {}, chatId: '', deadlineMs: 1000 })
    expect(result.ok).toBe(false)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('sends and receives a file in one step', async () => {
    const dir = tempDir()
    const host = new DeviceToolHost({ tools: () => [], context: (signal) => noCtx(signal), shared: () => DEFAULT_SHARE, inbox: join(dir, 'received') })
    const got = await host.run({ kind: 'tool', id: 'r', tool: 'file_receive', args: { name: '../report.txt', data: Buffer.from('hello').toString('base64') }, chatId: '', deadlineMs: 0 })
    expect(got.ok).toBe(true)
    const path = (got as { value: { path: string } }).value.path
    expect(path).toBe(join(dir, 'received', 'report.txt'))
    expect(readFileSync(path, 'utf8')).toBe('hello')
    const again = await host.run({ kind: 'tool', id: 'r2', tool: 'file_receive', args: { name: 'report.txt', data: '' }, chatId: '', deadlineMs: 0 })
    expect((again as { value: { path: string } }).value.path).toBe(join(dir, 'received', 'report (2).txt'))
    const sent = await host.run({ kind: 'tool', id: 's', tool: 'file_send', args: { path }, chatId: '', deadlineMs: 0 })
    expect(sent).toEqual({ ok: true, value: { type: 'file', name: 'report.txt', mime: 'text/plain; charset=utf-8', size: 5, data: Buffer.from('hello').toString('base64') } })
    expect((await host.run({ kind: 'tool', id: 's2', tool: 'file_send', args: { path: join(dir, 'missing') }, chatId: '', deadlineMs: 0 })).ok).toBe(false)
  })

  it('reads commands strictly and leaves plain text alone', () => {
    expect(toolCommand({ kind: 'tool', id: 'a', tool: 't', args: [1], chatId: 5 })).toEqual({ kind: 'tool', id: 'a', tool: 't', args: {}, chatId: '', deadlineMs: 0 })
    expect(toolCommand({ kind: 'tool', tool: 't' })).toBeNull()
    expect(resultValue('just words')).toEqual({ text: 'just words' })
  })
})

// ---- two real nodes ----

function secretsMap(): { get(n: string): string | null; set(n: string, v: string): void; delete(n: string): void } {
  const data = new Map<string, string>()
  return { get: (n) => data.get(n) ?? null, set: (n, v) => void data.set(n, v), delete: (n) => void data.delete(n) }
}

async function node(name: string, tools: Tool[] = []): Promise<{ service: DevicesService; store: Store; dir: string; secrets: ReturnType<typeof secretsMap> }> {
  const dir = tempDir()
  const store = new Store(join(dir, 'agent.db'))
  stores.push(store)
  const secrets = secretsMap()
  const service: DevicesService = new DevicesService({
    userData: dir,
    store,
    secrets,
    registry: new HandlerRegistry(),
    appVersion: '1.0.0',
    nodeName: () => name,
    platform: 'linux',
    ready: () => true,
    busy: () => false,
    rendererDir: join(dir, 'renderer'),
    emitWindow: () => undefined,
    deviceTools: new DeviceToolHost({ tools: () => tools, context: (signal) => noCtx(signal), shared: () => service.shareGroups(), inbox: join(dir, 'in') }),
  })
  services.push(service)
  await service.start()
  return { service, store, dir, secrets }
}

async function listenOn(service: DevicesService): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await service.configure({ listen: '127.0.0.1', port: 20000 + Math.floor(Math.random() * 30000) })
    const status = await service.setEnabled(true)
    if (status.running) return `https://127.0.0.1:${status.port}`
  }
  throw new Error('no port')
}

describe('the desktop node with Devices off', () => {
  it('makes no identity, no device row and no origin until it is switched on', async () => {
    const off = await node('Quiet desk')
    const status = off.service.status()
    expect(status).toMatchObject({ enabled: false, running: false, nodeId: '', fp: '', urls: [], firewall: 'not-needed', servingTo: '' })
    expect(existsSync(join(off.dir, 'devices', 'identity.json'))).toBe(false)
    expect(existsSync(join(off.dir, 'devices', 'node-key.pem'))).toBe(false)
    expect(await off.store.list('device')).toEqual([])
    expect(await off.service.runTool({ kind: 'tool', id: 'x', tool: 'file_send', args: {}, chatId: '', deadlineMs: 0 })).toEqual({ ok: false, error: 'Devices is off on this computer.' })
  })
})

describe('shared device tools across two nodes', () => {
  it('stores a device\'s tools from its hello and routes device.result to whoever listens', async () => {
    const brain = await node('Brain desk')
    const base = await listenOn(brain.service)
    const fp = brain.service.status().fp
    const offer = brain.service.offer()
    const phoneFacts = { name: 'Test phone', kind: 'phone', platform: 'android', appVersion: '1', screen: { width: 412, height: 900 }, canOpenLinks: true, canReceiveFiles: true, fingerprint: '', urls: [] }
    const paired = (await pinnedRequest(`${base}/v1/pair`, fp, { method: 'POST', body: { code: offer.shortCode, device: phoneFacts } })).json() as { deviceId: string; pass: string }
    const heard: Array<[string, string, DeviceToolResult]> = []
    brain.service.host().onDeviceResult((deviceId, id, result) => void heard.push([deviceId, id, result]))
    const phone = await connectRpc(base, fp, paired.pass, phoneFacts)
    phone.send({ type: 'hello', device: phoneFacts, tools: [{ name: 'notifications_read', description: 'Read the notifications', params: {}, group: 'notifications', readOnly: true }, { name: 'BAD NAME' }] })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const row = await brain.store.get('device', paired.deviceId)
    expect(row?.tools).toEqual([{ name: 'notifications_read', description: 'Read the notifications', params: {}, group: 'notifications', readOnly: true }])
    expect(await phone.call('device.result', 'cmd_9', true, { text: '3 new' })).toBe(true)
    expect(await phone.call('device.result', 'cmd_10', false, 'No permission')).toBe(true)
    expect(heard).toEqual([
      [paired.deviceId, 'cmd_9', { ok: true, value: { text: '3 new' } }],
      [paired.deviceId, 'cmd_10', { ok: false, error: 'No permission' }],
    ])
    phone.close()
  })

  it('links OUT to the answering brain, says hello with its tools and serves a command', async () => {
    const brain = await node('Brain server')
    const brainBase = await listenOn(brain.service)
    const brainSelf = await brain.store.get('device', brain.service.identity.nodeId)
    expect(brainSelf).not.toBeNull()

    const desk = await node('Desk behind a firewall', [fakeTool('browser_read', async (input) => `read ${String(input['url'] ?? '')}`)])
    // What sync and the bundle do in the app (workstream B): each side learns the other's row; the brain learns the
    // desk's pass hash. Here by hand, so this test covers only this lane.
    if (brainSelf !== null) await desk.store.upsert('device', { ...brainSelf, urls: [brainBase] })
    await listenOn(desk.service)
    const deskSelf = await desk.store.get('device', desk.service.identity.nodeId)
    expect(deskSelf?.priority).toBe(1)
    expect(deskSelf?.tools?.map((t) => t.name)).toEqual(['browser_read', 'file_send', 'file_receive'])
    if (deskSelf !== null) await brain.store.upsert('device', deskSelf)
    brain.service.passTable().replaceAll({ ...brain.service.passTable().all(), ...desk.service.passTable().all() })
    // Its first try ran before the brain knew it (401); the next check (every 15 s) is made now.
    await desk.service.uplinkNow()

    for (let i = 0; i < 40 && !brain.service.host().isConnected(desk.service.identity.nodeId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(brain.service.host().isConnected(desk.service.identity.nodeId)).toBe(true)
    expect(desk.service.status().servingTo).toBe(brain.service.identity.nodeId)
    expect(brain.service.host().factsOf(desk.service.identity.nodeId)?.tools?.map((t) => t.name)).toContain('browser_read')

    const result = new Promise<DeviceToolResult>((resolve) => {
      brain.service.host().onDeviceResult((deviceId, id, value) => {
        if (deviceId === desk.service.identity.nodeId && id === 'cmd_1') resolve(value)
      })
    })
    brain.service.host().emit(desk.service.identity.nodeId, 'device.command', { kind: 'tool', id: 'cmd_1', tool: 'browser_read', args: { url: 'https://example.com/' }, chatId: 'main', deadlineMs: 5000 })
    expect(await result).toEqual({ ok: true, value: { text: 'read https://example.com/' } })

    // The desk becomes the first brain: it stops linking out, it answers itself.
    await desk.service.move(desk.service.identity.nodeId, 'up')
    await desk.service.uplinkNow()
    expect(desk.service.status().servingTo).toBe('')
  })
})
