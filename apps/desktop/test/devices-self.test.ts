/**
 * This node's id is asked for on every turn, command and sync step. Reading it must not build the node's facts (its
 * network interfaces and tool list), which are slow to read on Windows; the facts are still there when asked for.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { HandlerRegistry } from '../src/main/devices/registry'
import { DevicesService } from '../src/main/devices/service'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const done of cleanups.splice(0).reverse()) await done()
})

describe('this node’s id is cheap', () => {
  it('self().id does not build the facts; self().facts still does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-self-'))
    const store = new Store(join(dir, 'agent.db'))
    const data = new Map<string, string>()
    let factsBuilt = 0
    const service = new DevicesService({
      userData: dir,
      store,
      secrets: { get: (n) => data.get(n) ?? null, set: (n, v) => void data.set(n, v), delete: (n) => void data.delete(n) },
      registry: new HandlerRegistry(),
      appVersion: '1.0.0',
      nodeName: () => {
        factsBuilt += 1
        return 'Test node'
      },
      platform: 'linux',
      ready: () => true,
      busy: () => false,
      rendererDir: join(dir, 'none'),
      emitWindow: () => undefined,
    })
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => store.close(), () => service.stop())
    const host = (service as unknown as { server: { self(): { id: string; facts: { name: string; urls: string[] } } } }).server
    const before = factsBuilt
    const ids = new Set<string>()
    for (let i = 0; i < 200; i += 1) ids.add(host.self().id)
    expect(ids.size).toBe(1)
    expect([...ids][0]).not.toBe('')
    expect(factsBuilt).toBe(before)
    const facts = host.self().facts
    expect(facts.name).toBe('Test node')
    expect(Array.isArray(facts.urls)).toBe(true)
    expect(factsBuilt).toBe(before + 1)
  })
})
