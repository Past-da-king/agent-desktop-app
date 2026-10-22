import { X509Certificate, createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { fingerprintOf, makeSelfSignedCert, time } from '../src/main/devices/cert'
import { advertisedUrls, cleanConfig, isAdvertisable, normaliseUrl } from '../src/main/devices/config'
import { cleanFacts } from '../src/main/devices/facts'
import { loadIdentity } from '../src/main/devices/identity'
import { MAX_WRONG, OFFER_MS, PairingOffers, SHORT_ALPHABET, formatShortCode, handlePair, makeShortCode, pairUri, parsePairUri } from '../src/main/devices/pairing'
import { SecretPassTable, hashPass, newPass, sameHash, type SecretsLike } from '../src/main/devices/passes'
import { HandlerRegistry, recordHandlers, wireOf } from '../src/main/devices/registry'
import { compilePath, matchPath, passFrom } from '../src/main/devices/router'
import { callAllowed } from '../src/main/devices/rpc'
import { parseRange } from '../src/main/devices/server'
import type { DeviceRecord, MessageOrigin } from '../src/main/devices/types'
import { FrameReader, OP, acceptKey, encodeFrame } from '../src/main/devices/ws'
import { CHANNELS } from '../src/shared/channels'
import { NOT_AVAILABLE, RPC_ALLOWED, RPC_CHANNELS, decodeWire, encodeWire } from '../src/shared/rpc-methods'
import { qrMatrix, versionFor } from '../src/shared/qr'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function memorySecrets(): SecretsLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, get: (n) => data.get(n) ?? null, set: (n, v) => void data.set(n, v), delete: (n) => void data.delete(n) }
}

const phone = { name: 'Test phone', kind: 'phone', platform: 'android', appVersion: '1.0', screen: { width: 412, height: 915 }, canOpenLinks: true, canReceiveFiles: true, fingerprint: '', urls: [] }

describe('node certificate', () => {
  it('is a valid self-signed ECDSA P-256 certificate whose fingerprint is sha256 of its DER', () => {
    const made = makeSelfSignedCert('Agent node test')
    const cert = new X509Certificate(made.certDer)
    expect(cert.subject).toContain('CN=Agent node test')
    expect(cert.issuer).toBe(cert.subject)
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1')
    expect(cert.verify(cert.publicKey)).toBe(true)
    expect(cert.ca).toBe(false)
    expect(new Date(cert.validTo).getUTCFullYear()).toBeGreaterThanOrEqual(new Date().getUTCFullYear() + 19)
    expect(fingerprintOf(made.certDer)).toBe(createHash('sha256').update(made.certDer).digest('base64url'))
    expect(fingerprintOf(made.certDer)).toHaveLength(43)
  })

  it('writes UTCTime before 2050 and GeneralizedTime after', () => {
    expect(time(new Date(Date.UTC(2049, 0, 2, 3, 4, 5)))[0]).toBe(0x17)
    expect(time(new Date(Date.UTC(2050, 0, 2, 3, 4, 5)))[0]).toBe(0x18)
  })

  it('keeps the same identity across starts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-id-'))
    dirs.push(dir)
    const first = loadIdentity(dir)
    const again = loadIdentity(dir)
    expect(again.nodeId).toBe(first.nodeId)
    expect(again.meshId).toBe(first.meshId)
    expect(again.fp).toBe(first.fp)
    expect(first.nodeId.startsWith('dev_')).toBe(true)
  })
})

describe('pairing offers', () => {
  it('uses an alphabet with no 0, O, 1 or I and makes 8 characters', () => {
    for (const ch of '0O1I') expect(SHORT_ALPHABET).not.toContain(ch)
    expect(SHORT_ALPHABET).toHaveLength(32)
    for (let i = 0; i < 200; i += 1) {
      const code = makeShortCode()
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
    }
    expect(formatShortCode('ABCDEFGH')).toBe('ABCD-EFGH')
  })

  it('takes the QR secret or the short code typed loosely, once', () => {
    let now = 1000
    const offers = new PairingOffers(() => now)
    const offer = offers.create()
    expect(offers.consume(offer.secret)).toEqual({ ok: true })
    expect(offers.consume(offer.secret)).toEqual({ ok: false, reason: 'none' })
    const next = offers.create()
    const typed = `${next.shortCode.slice(0, 4).toLowerCase()} - ${next.shortCode.slice(4)}`
    expect(offers.consume(typed)).toEqual({ ok: true })
    now += 1
  })

  it('runs out after 10 minutes', () => {
    let now = 5000
    const offers = new PairingOffers(() => now)
    const offer = offers.create()
    expect(offer.expiresAt - offer.createdAt).toBe(OFFER_MS)
    now += OFFER_MS
    expect(offers.consume(offer.shortCode)).toEqual({ ok: false, reason: 'expired' })
  })

  it('burns the offer after five wrong tries', () => {
    const offers = new PairingOffers()
    const offer = offers.create()
    for (let i = 0; i < MAX_WRONG - 1; i += 1) expect(offers.consume('WRONGCOD')).toEqual({ ok: false, reason: 'wrong' })
    expect(offers.current()).not.toBeNull()
    expect(offers.consume('WRONGCOD')).toEqual({ ok: false, reason: 'wrong' })
    expect(offers.consume(offer.shortCode)).toEqual({ ok: false, reason: 'none' })
  })

  it('round-trips the agent://pair URI', () => {
    const parts = { meshId: 'mesh_x', nodeId: 'dev_y', name: 'Desk & co', urls: ['https://127.0.0.1:7787', 'https://[fd00::1]:7787'], fp: 'f'.repeat(43), secret: 'abc' }
    const uri = pairUri(parts)
    expect(uri.startsWith('agent://pair?v=1&mesh=mesh_x&node=dev_y&name=Desk%20%26%20co&u=')).toBe(true)
    expect(parsePairUri(uri)).toEqual(parts)
    expect(parsePairUri('agent://pair?v=2&mesh=a')).toBeNull()
  })

  it('issues a device id and a pass, stores only its hash, and writes the device row', async () => {
    const offers = new PairingOffers()
    const offer = offers.create()
    const passes = new SecretPassTable(memorySecrets())
    const saved: DeviceRecord[] = []
    const deps = {
      offers,
      passes,
      meshId: 'mesh_t',
      node: { id: 'dev_node', name: 'Desk' },
      saveDevice: async (row: DeviceRecord) => void saved.push(row),
      brains: async () => [{ id: 'dev_node', name: 'Desk', urls: [], fp: 'x', priority: 0 }],
      nextPriority: async () => 1,
    }
    expect((await handlePair({ code: offer.shortCode }, deps)).status).toBe(400)
    const answer = await handlePair({ code: offer.shortCode, device: phone, wantRoles: ['screen', 'bogus'] }, deps)
    expect(answer.status).toBe(200)
    if (answer.status !== 200) return
    expect(answer.json.pass).toHaveLength(43)
    expect(passes.all()[answer.json.deviceId]).toBe(hashPass(answer.json.pass))
    expect(JSON.stringify(passes.all())).not.toContain(answer.json.pass)
    expect(passes.deviceFor(answer.json.pass)).toBe(answer.json.deviceId)
    expect(saved[0]?.roles).toEqual(['screen'])
    expect(saved[0]?.name).toBe('Test phone')
    expect(answer.json.brains[0]?.id).toBe('dev_node')
    expect((await handlePair({ code: offer.shortCode, device: phone }, deps)).status).toBe(410)
  })
})

describe('passes', () => {
  it('are 256-bit, hashed with sha256 and compared in constant time', () => {
    const pass = newPass()
    expect(Buffer.from(pass, 'base64url')).toHaveLength(32)
    expect(hashPass(pass)).toMatch(/^[0-9a-f]{64}$/)
    expect(sameHash(hashPass(pass), hashPass(pass))).toBe(true)
    expect(sameHash(hashPass(pass), hashPass(`${pass}x`))).toBe(false)
    expect(sameHash('', '')).toBe(false)
  })

  it('keep the table in the secrets store and forget a removed device', () => {
    const secrets = memorySecrets()
    const table = new SecretPassTable(secrets)
    table.set('dev_a', hashPass('a'))
    table.set('dev_b', hashPass('b'))
    expect(new SecretPassTable(secrets).deviceFor('b')).toBe('dev_b')
    table.remove('dev_b')
    expect(new SecretPassTable(secrets).deviceFor('b')).toBeNull()
    table.replaceAll({ dev_c: hashPass('c'), bad: 'nothex' })
    expect(Object.keys(table.all())).toEqual(['dev_c'])
  })
})

describe('routes and auth', () => {
  it('matches :params and a trailing *', () => {
    expect(matchPath(compilePath('/v1/devices/:id/revoke'), '/v1/devices/dev_1/revoke')).toEqual({ id: 'dev_1' })
    expect(matchPath(compilePath('/v1/devices/:id/revoke'), '/v1/devices/a/b/revoke')).toBeNull()
    expect(matchPath(compilePath('/v1/devices/:id/revoke'), '/v1/devices/%E0%A4%A/revoke')).toBeNull()
    expect(matchPath(compilePath('/app/*'), '/app/assets/x.js')).toEqual({ '*': 'assets/x.js' })
    expect(matchPath(compilePath('/app/*'), '/app/')).toEqual({ '*': '' })
    expect(matchPath(compilePath('/v1.x'), '/v1ax')).toBeNull()
  })

  it('reads the pass from Bearer or the agent_pass cookie', () => {
    expect(passFrom({ authorization: 'Bearer abc' })).toBe('abc')
    expect(passFrom({ cookie: 'a=1; agent_pass=xyz=; b=2' })).toBe('xyz=')
    expect(passFrom({ authorization: 'Basic abc' })).toBe('')
    expect(passFrom({})).toBe('')
  })

  it('parses byte ranges', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=100-', 100)).toBe('bad')
    expect(parseRange(undefined, 100)).toBeNull()
  })
})

describe('websocket framing', () => {
  it('computes the RFC 6455 accept key', () => {
    // The example from RFC 6455 section 1.3.
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

  it('round-trips masked frames of every length class, split at any byte', () => {
    for (const size of [0, 5, 125, 126, 65535, 65536, 200_000]) {
      const payload = Buffer.alloc(size, 7)
      const frame = encodeFrame(OP.binary, payload, true)
      const reader = new FrameReader()
      const out = [...reader.push(frame.subarray(0, 3)), ...reader.push(frame.subarray(3))]
      expect(out).toHaveLength(1)
      expect(out[0]?.masked).toBe(true)
      expect(out[0]?.payload.equals(payload)).toBe(true)
    }
  })

  it('refuses a frame bigger than the cap', () => {
    const reader = new FrameReader(10)
    expect(() => reader.push(encodeFrame(OP.text, Buffer.alloc(11)))).toThrow()
  })
})

describe('the wire allowlist', () => {
  const origin: MessageOrigin = { deviceId: 'dev_p', name: 'Test phone', kind: 'phone', platform: 'android', screenWidth: 412, canOpenLinks: true, canReceiveFiles: true }
  const session = { deviceId: 'dev_p', origin: () => origin }

  it('names real channels for every allowed method', () => {
    for (const name of RPC_ALLOWED) expect(RPC_CHANNELS[name], name).toMatch(/^agent:/)
    expect(RPC_CHANNELS['settings.accounts.add']).toBe(CHANNELS.settings.accounts.add)
    for (const never of ['settings.save', 'settings.setApiKey', 'apps.setKey', 'window.close', 'files.pick', 'shell.openExternal', 'dictation.audio', 'hotkeys.pause', 'voice.setKey', 'account.signIn', 'settings.reset']) {
      expect(RPC_ALLOWED.has(never), never).toBe(false)
    }
  })

  it('calls the recorded handler with the caller, and refuses the rest', async () => {
    const registry = new HandlerRegistry()
    const seen: unknown[] = []
    const ipc = recordHandlers({ handle: (_channel: string, _listener: unknown) => undefined }, registry)
    ipc.handle(CHANNELS.chat.send, async (event, ...args) => {
      seen.push(wireOf(event), args)
      return 'sent'
    })
    ipc.handle(CHANNELS.settings.setApiKey, async () => 'leaked')
    ipc.handle(CHANNELS.data.upsert, async () => 'row')
    expect(await callAllowed(registry, new Map(), session, 'chat.send', ['hi', [], ''])).toBe('sent')
    expect(seen[0]).toEqual({ deviceId: 'dev_p', origin })
    expect(seen[1]).toEqual(['hi', [], ''])
    await expect(callAllowed(registry, new Map(), session, 'settings.setApiKey', ['k'])).rejects.toThrow(NOT_AVAILABLE)
    await expect(callAllowed(registry, new Map(), session, 'nope.nothing', [])).rejects.toThrow(NOT_AVAILABLE)
    await expect(callAllowed(registry, new Map(), session, 'data.upsert', ['device', {}])).rejects.toThrow(NOT_AVAILABLE)
    expect(await callAllowed(registry, new Map(), session, 'data.upsert', ['task', {}])).toBe('row')
    // A method another part added answers first.
    const added = new Map([['sync.status', async (id: string) => `for ${id}`]])
    expect(await callAllowed(registry, added, session, 'sync.status', [])).toBe('for dev_p')
  })

  it('carries bytes as base64 both ways', () => {
    const bytes = new Uint8Array([0, 1, 2, 250])
    const wire = encodeWire({ a: [bytes], b: 'x' })
    expect(JSON.parse(JSON.stringify(wire))).toEqual({ a: [{ $b64: 'AAEC+g==' }], b: 'x' })
    const back = decodeWire(JSON.parse(JSON.stringify(wire))) as { a: Uint8Array[] }
    expect([...(back.a[0] ?? [])]).toEqual([0, 1, 2, 250])
  })
})

describe('facts and config', () => {
  it('cleans device facts', () => {
    expect(cleanFacts({ ...phone, name: 'A\u0000B'.padEnd(200, 'x') })?.name).toHaveLength(80)
    expect(cleanFacts({ ...phone, kind: 'toaster' })).toBeNull()
    expect(cleanFacts({ ...phone, urls: ['https://127.0.0.1:7787', 'http://x', 5] })?.urls).toEqual(['https://127.0.0.1:7787'])
  })

  it('normalises extra addresses and advertises interface addresses', () => {
    expect(normaliseUrl('my-node.example.net', 7787)).toBe('https://my-node.example.net:7787')
    expect(normaliseUrl('https://my-node.example.net:9000', 7787)).toBe('https://my-node.example.net:9000')
    expect(normaliseUrl('http://x', 7787)).toBeNull()
    expect(cleanConfig({ port: 99999, enabled: 'yes' })).toMatchObject({ port: 7787, enabled: false })
    expect(isAdvertisable('127.0.0.1', 'IPv4', false)).toBe(false)
    expect(isAdvertisable('169.254.3.4', 'IPv4', false)).toBe(false)
    expect(isAdvertisable('fe80::1', 'IPv6', false)).toBe(false)
    const interfaces = {
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '', mac: '', cidr: null }],
      eth0: [
        { address: '192.0.2.10', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null },
        { address: 'fe80::1', family: 'IPv6', internal: false, netmask: '', mac: '', cidr: null, scopeid: 1 },
        { address: '2001:db8::5', family: 'IPv6', internal: false, netmask: '', mac: '', cidr: null, scopeid: 0 },
      ],
    } as unknown as Parameters<typeof advertisedUrls>[1]
    const config = { enabled: true, port: 7787, listen: '0.0.0.0', extraUrls: ['https://my-node.example.net:7787'] }
    expect(advertisedUrls(config, interfaces)).toEqual(['https://my-node.example.net:7787', 'https://192.0.2.10:7787', 'https://[2001:db8::5]:7787'])
    expect(advertisedUrls({ ...config, listen: '127.0.0.1' }, interfaces)).toEqual(['https://my-node.example.net:7787'])
    // A node that could only listen on IPv4 does not hand out IPv6 addresses that would not answer.
    expect(advertisedUrls(config, interfaces, false)).toEqual(['https://my-node.example.net:7787', 'https://192.0.2.10:7787'])
  })
})

describe('qr', () => {
  it('picks the smallest version and draws a square with three finders', () => {
    expect(versionFor(14)).toBe(1)
    expect(versionFor(15)).toBe(2)
    const m = qrMatrix('agent://pair?v=1')
    expect(m.length).toBe(21 + 4 * (versionFor(16) - 1))
    for (const [x, y] of [[0, 0], [m.length - 7, 0], [0, m.length - 7]] as const) {
      expect(m[y]?.[x]).toBe(true)
      expect(m[y + 1]?.[x + 1]).toBe(false)
      expect(m[y + 3]?.[x + 3]).toBe(true)
    }
  })
})
