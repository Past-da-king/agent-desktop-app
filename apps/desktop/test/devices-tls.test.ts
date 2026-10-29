/**
 * The real network path between nodes: HTTPS with a self-signed certificate, pinned by fingerprint. Certificates are
 * made on the fly with the openssl tool (skipped where it is not installed).
 */
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SyncClient } from '@agent/core'

import { Store } from '../src/main/db'
import { PinMismatch, fingerprintOf, pinnedFetch } from '../src/main/devices/pinned-fetch'
import { Replicator, registerSyncRoutes } from '../src/main/devices/replicate'
import { probeHealth } from '../src/main/devices/sync'
import { closeKeptAgents } from '../src/main/devices/socks'
import { startTestHost, type TestHost } from './devices-host'
import { waitFor } from '../../../packages/core/test/helpers'

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function makeCert(): { key: string; cert: string; fp: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-cert-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=agent-node', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' })
    const cert = readFileSync(join(dir, 'c.pem'), 'utf8')
    return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert, fp: fingerprintOf(new X509Certificate(cert).raw) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

async function tlsNode(id: string, tls: { key: string; cert: string }): Promise<{ store: Store; host: TestHost }> {
  const store = new Store(':memory:')
  const host = await startTestHost(id, undefined, tls)
  registerSyncRoutes(host, store)
  host.addRoute({ method: 'GET', path: '/v1/health', auth: 'none', handle: async () => ({ status: 200, json: { id, ready: true } }) })
  cleanups.push(async () => {
    await host.close()
    store.close()
  })
  return { store, host }
}

describe.skipIf(!hasOpenssl())('nodes over pinned HTTPS', () => {
  it('replicates over TLS with the default pinned client, and refuses a certificate it did not pair with', async () => {
    const certA = makeCert()
    const certB = makeCert()
    const a = await tlsNode('dev_a', certA)
    const b = await tlsNode('dev_b', certB)
    for (const n of [a, b]) {
      n.host.passes.set('pass-a', { deviceId: 'dev_a', node: true })
      n.host.passes.set('pass-b', { deviceId: 'dev_b', node: true })
    }

    // A replicates with B using the real default client: pinned to B's fingerprint.
    const replicator = new Replicator({
      store: a.store,
      selfId: () => 'dev_a',
      pass: () => 'pass-a',
      peers: async () => [{ id: 'dev_b', name: 'B', urls: [b.host.url], fp: certB.fp }],
      waitSeconds: 1,
      initialBackoffMs: 50,
    })
    replicator.start()
    cleanups.push(() => replicator.stop())
    await a.store.upsert('memory', { title: 'Over TLS' })
    await waitFor(async () => (await b.store.list('memory')).some((row) => row.title === 'Over TLS'), 8000)
    await b.store.upsert('memory', { title: 'Back over TLS' })
    await waitFor(async () => (await a.store.list('memory')).some((row) => row.title === 'Back over TLS'), 8000)

    // The wrong pin: refused before the pass is sent. B's server never sees an authenticated request.
    replicator.stop()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const before = b.host.hits.get('/v1/sync/pull') ?? 0
    const wrong = new SyncClient(b.host.url, 'pass-a', pinnedFetch(certA.fp))
    await expect(wrong.pull(0)).rejects.toThrow(new PinMismatch().message)
    expect(b.host.hits.get('/v1/sync/pull') ?? 0).toBe(before)

    // No pin at all is refused too, and plain http is never used.
    await expect(pinnedFetch('')(`${b.host.url}/v1/health`)).rejects.toThrow()
    await expect(pinnedFetch(certB.fp)(b.host.url.replace('https:', 'http:') + '/v1/health')).rejects.toThrow('https')
  })

  it('probes health through the pin: up and ready, or down', async () => {
    const cert = makeCert()
    const a = await tlsNode('dev_a', cert)
    const row = { id: 'dev_a', name: 'A', kind: 'desktop', platform: 'linux', roles: ['brain'], priority: 0, urls: [a.host.url], fp: cert.fp, facts: {}, pairedAt: 0, lastSeen: 0, revoked: false, createdAt: 0 }
    expect(await probeHealth(row)).toEqual({ up: true, ready: true })
    expect(await probeHealth({ ...row, fp: makeCert().fp })).toEqual({ up: false, ready: false })
    a.host.down = true
    expect(await probeHealth(row)).toEqual({ up: false, ready: false })
  })
  it('keeps one connection open for many requests, and still checks the pin on a reused one', async () => {
    const cert = makeCert()
    let handshakes = 0
    let requests = 0
    const server = createHttpsServer({ key: cert.key, cert: cert.cert }, (req, res) => {
      requests += 1
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, path: req.url }))
      })
    })
    server.keepAliveTimeout = 30_000
    server.on('secureConnection', () => {
      handshakes += 1
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => {
      closeKeptAgents()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    })
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
    // Ten requests, each from a fresh pinnedFetch as the replicator makes them per pass: one handshake (was ten).
    for (let i = 0; i < 10; i++) {
      const res = await pinnedFetch(cert.fp)(`${url}/v1/sync/pull?since=${i}`, { method: i % 2 === 0 ? 'GET' : 'POST', body: i % 2 === 0 ? undefined : '{}' })
      expect(res.status).toBe(200)
    }
    expect(requests).toBe(10)
    expect(handshakes).toBe(1)
    // The kept socket is pinned to this certificate: another pin on the same address is refused before anything is sent.
    await expect(pinnedFetch(makeCert().fp)(`${url}/v1/health`)).rejects.toThrow(new PinMismatch().message)
    expect(requests).toBe(10)
    // And the right pin still works afterwards.
    expect((await pinnedFetch(cert.fp)(`${url}/v1/health`)).status).toBe(200)
  })
})
