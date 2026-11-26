/**
 * 26 Nov 2026: the server's node.json kept the PC at 192.168.50.35 after it moved to .36, and the main agent had to
 * put the WSL relay address in by hand: brains' addresses were written at pairing and never looked at again. They now
 * follow the replicated device rows, keep what the person pinned or added while it works, and drop only addresses
 * that are gone from the row or proven dead.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DeviceRow } from '@agent/core'

import { BrainUrlRefresher, DEAD_AFTER, DEAD_SPAN_MS, refreshEntry, type BrainEntry } from '../src/headless/brain-urls'

const RELAY = 'https://100.100.10.20:7788'
const TS = 'https://100.100.10.40:7787'
const V6 = 'https://[fd7a:115c:a1e0::1234]:7787'
const OLD_LAN = 'https://192.168.50.35:7787'
const NEW_LAN = 'https://192.168.50.36:7787'
const FP = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdEFG'

const never = (): boolean => false

describe('refreshEntry', () => {
  const pc: BrainEntry = { id: 'dev_pc', name: 'PC', urls: [TS, V6, OLD_LAN], fp: FP, priority: 0 }

  it('takes the addresses the row publishes now, and keeps an unknown old one at the back until it is proven dead', () => {
    const next = refreshEntry(pc, { urls: [TS, V6, NEW_LAN], fp: FP, revoked: false }, never)
    expect(next.urls).toEqual([TS, V6, NEW_LAN, OLD_LAN])
    expect(next.learned).toEqual([TS, V6, NEW_LAN])
    const dead = refreshEntry(next, { urls: [TS, V6, NEW_LAN], fp: FP, revoked: false }, (url) => url === OLD_LAN)
    expect(dead.urls).toEqual([TS, V6, NEW_LAN])
  })

  it('drops an address the row published before and no longer does (gone, not hand-added)', () => {
    const learned: BrainEntry = { ...pc, urls: [TS, V6, NEW_LAN], learned: [TS, V6, NEW_LAN] }
    const next = refreshEntry(learned, { urls: [TS, V6, 'https://192.168.50.40:7787'], fp: FP, revoked: false }, never)
    expect(next.urls).toEqual([TS, V6, 'https://192.168.50.40:7787'])
  })

  it('keeps a hand-added relay that answers first, ahead of row addresses that may be down; pinned stays always', () => {
    const live = { ...pc, urls: [RELAY, TS, V6, NEW_LAN] }
    const next = refreshEntry(live, { urls: [TS, V6, NEW_LAN], fp: FP, revoked: false }, never, (url) => url === RELAY)
    expect(next.urls).toEqual([RELAY, TS, V6, NEW_LAN])
    const pinned = refreshEntry({ ...live, pinned: ['https://pc.example:7787'] }, { urls: [TS], fp: FP, revoked: false }, () => true)
    // "dead" never touches a pinned address; the row's own address stays even when it fails.
    expect(pinned.urls).toEqual(['https://pc.example:7787', TS])
  })

  it('leaves the entry alone for a missing row, a taken-out device or another certificate', () => {
    expect(refreshEntry(pc, undefined, never)).toBe(pc)
    expect(refreshEntry(pc, { urls: [NEW_LAN], fp: FP, revoked: true }, never)).toBe(pc)
    expect(refreshEntry(pc, { urls: [NEW_LAN], fp: 'another-certificate', revoked: false }, never)).toBe(pc)
  })

  it('gives back the same object when nothing changed (no write)', () => {
    const settled = refreshEntry(pc, { urls: [TS, V6, OLD_LAN], fp: FP, revoked: false }, never)
    expect(refreshEntry(settled, { urls: [TS, V6, OLD_LAN], fp: FP, revoked: false }, never)).toBe(settled)
  })
})

describe('BrainUrlRefresher on a real node.json', () => {
  const dirs: string[] = []
  afterEach(() => {
    vi.useRealTimers()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function nodeDir(brains: BrainEntry[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'brain-urls-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'node.json'), JSON.stringify({ id: 'node_x', name: 'impetix', meshId: 'mesh_x', listen: '127.0.0.1', port: 7787, publicUrls: [], brains, deviceId: 'dev_srv', proxy: '', join: null }))
    return dir
  }
  const brainsOf = (dir: string): BrainEntry[] => (JSON.parse(readFileSync(join(dir, 'node.json'), 'utf8')) as { brains: BrainEntry[] }).brains
  const row = (urls: string[]): DeviceRow => ({ id: 'dev_pc', name: 'PC', urls, fp: FP, roles: ['brain', 'hands'], priority: 0, revoked: false, kind: 'desktop', platform: 'windows', facts: {} as DeviceRow['facts'], pairedAt: 1, lastSeen: 1, createdAt: 1 }) as DeviceRow

  it('brings a stale address up to date from the row, and drops it only once proven dead while the brain answers', async () => {
    const dir = nodeDir([{ id: 'dev_pc', name: 'PC', urls: [TS, OLD_LAN], fp: FP, priority: 0 }])
    let rows = [row([TS, NEW_LAN])]
    const refresher = new BrainUrlRefresher({ dataDir: dir, rows: async () => rows, probe: async (url) => url !== OLD_LAN })
    expect(await refresher.refresh()).toBe(true)
    expect(brainsOf(dir)[0]?.urls).toEqual([TS, NEW_LAN, OLD_LAN])
    // A few failed checks are not proof: it stays.
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    for (let i = 0; i < DEAD_AFTER - 1; i += 1) await refresher.probeOthers()
    vi.setSystemTime(Date.now() + DEAD_SPAN_MS + 1)
    expect(await refresher.refresh()).toBe(false)
    expect(brainsOf(dir)[0]?.urls).toContain(OLD_LAN)
    await refresher.probeOthers()
    expect(await refresher.refresh()).toBe(true)
    expect(brainsOf(dir)[0]?.urls).toEqual([TS, NEW_LAN])
    // The row moves on again: the address it published before and dropped is gone at once.
    rows = [row([TS, 'https://192.168.50.40:7787'])]
    expect(await refresher.refresh()).toBe(true)
    expect(brainsOf(dir)[0]?.urls).toEqual([TS, 'https://192.168.50.40:7787'])
  })

  it('never drops an unknown address while the brain answers nowhere (it may be the only way)', async () => {
    const dir = nodeDir([{ id: 'dev_pc', name: 'PC', urls: [RELAY, TS], fp: FP, priority: 0 }])
    const refresher = new BrainUrlRefresher({ dataDir: dir, rows: async () => [row([TS])], probe: async () => false })
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    for (let i = 0; i < DEAD_AFTER + 2; i += 1) await refresher.probeOthers()
    vi.setSystemTime(Date.now() + DEAD_SPAN_MS * 2)
    await refresher.probeOthers()
    await refresher.refresh()
    expect(brainsOf(dir)[0]?.urls).toContain(RELAY)
  })
})
