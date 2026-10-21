import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { importKind, parseExport, planImport, rowIdFor, runImport } from '../src/main/memory/importer'

let store: Store

beforeEach(() => {
  store = new Store(':memory:')
})

afterEach(() => {
  store.close()
})

const exportFile = JSON.stringify({
  source: 'Test Bank',
  memories: [
    { id: 'm_1', title: 'Ben van Rooyen', text: 'CEO of Guavas. Final sign-off on positioning.', kind: 'person', project: 'growos', topics: ['people'], life: 'work', date: '2026-08-01T10:00:00Z', status: 'active' },
    { id: 'm_2', title: 'Deploy the site', text: '1. npm run build\n2. wrangler deploy', kind: 'how-to', project: '', topics: ['deploy'], life: 'work', date: '2026-08-02T10:00:00Z', status: 'active' },
    { id: 'm_3', title: 'Chose Cloudflare', text: 'Decided to host on Cloudflare because it is free.', kind: 'decision', project: 'creek', topics: [], life: 'work', date: 1786000000000, status: 'active' },
    { id: 'm_4', title: 'API reference', text: 'The CRM API lives at /api/v2. Token: sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345', kind: 'reference', project: 'crm', topics: [], life: 'work', date: '2026-08-03', status: 'active' },
    { id: 'm_5', title: 'A fact', text: 'Durban is humid in summer.', kind: 'fact', project: '', topics: [], life: 'personal', date: '2026-08-04', status: 'active' },
    { id: 'm_6', title: 'Doing the deploy now', text: 'Currently halfway through the deploy.', kind: 'state', project: '', topics: [], life: 'work', date: '2026-08-05', status: 'active' },
    { id: 'm_7', title: 'Meeting happened', text: 'Met Ben on Tuesday.', kind: 'event', project: '', topics: [], life: 'work', date: '2026-08-06', status: 'active' },
    { id: 'm_8', title: 'Old decision', text: 'Host on Vercel.', kind: 'decision', project: '', topics: [], life: 'work', date: '2026-07-01', status: 'retired' },
    { id: 'org:guavas', title: 'Guavas', text: 'A lender marketplace. People: [[Ben van Rooyen]].', kind: 'organisation', project: '', topics: [], life: 'work', date: '2026-08-01', status: 'active' },
    { id: 'project:creek', title: 'Creek Retreats', text: 'Three sites and social.', kind: 'project', project: 'creek', topics: [], life: 'work', date: '2026-08-01', status: 'active' },
    { id: '', title: 'No id', text: 'x', kind: 'fact' },
  ],
})

describe('memory import', () => {
  it('maps kinds onto the app: people, how-tos, decisions, facts', () => {
    expect(importKind('person')).toBe('person')
    expect(importKind('how-to')).toBe('how-to')
    expect(importKind('decision')).toBe('decision')
    expect(importKind('reference')).toBe('fact')
    expect(importKind('fact')).toBe('fact')
    expect(importKind('organization')).toBe('organisation')
    expect(importKind('project')).toBe('project')
    expect(importKind('state')).toBe('event')
    expect(importKind('nonsense')).toBeNull()
  })

  it('previews per kind and leaves retired and short-lived notes out by default', () => {
    const { preview } = planImport(parseExport(exportFile), false)
    expect(preview).toMatchObject({
      ok: true,
      source: 'Test Bank',
      total: 11,
      byKind: { person: 1, 'how-to': 1, decision: 1, fact: 2, organisation: 1, project: 1 },
      skippedRetired: 1,
      skippedTransient: 2,
      invalid: 1,
    })
    const all = planImport(parseExport(exportFile), true).preview
    expect(all.byKind).toMatchObject({ decision: 2, event: 2 })
    expect(all.skippedRetired + all.skippedTransient).toBe(0)
  })

  it('writes rows keyed on the source id, redacted, and is idempotent', async () => {
    let changes = 0
    store.onChange(() => (changes += 1))
    const first = await runImport(store, exportFile, false)
    expect(first).toMatchObject({ added: 7, updated: 0, unchanged: 0, redacted: 1 })
    // One change event for the whole import, not one per row.
    expect(changes).toBe(1)

    const rows = await store.list('memory')
    expect(rows).toHaveLength(7)
    const ben = await store.get('memory', rowIdFor('m_1'))
    expect(ben).toMatchObject({ title: 'Ben van Rooyen', kind: 'person', topics: 'growos, people, work', source: 'user', pinned: false })
    expect(ben?.createdAt).toBe(Date.parse('2026-08-01T10:00:00Z'))
    const api = await store.get('memory', rowIdFor('m_4'))
    expect(api?.kind).toBe('fact')
    expect(api?.body).not.toContain('sk-ant')
    expect(rowIdFor('org:guavas')).toMatch(/^import-[0-9a-f]{20}$/)

    const again = await runImport(store, exportFile, false)
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 7 })
    expect(await store.list('memory')).toHaveLength(7)

    // A changed entry updates in place, and a pin the person set survives.
    await store.upsert('memory', { ...(ben ?? {}), pinned: true })
    const edited = exportFile.replace('Final sign-off on positioning.', 'Final sign-off on positioning and pricing.')
    const third = await runImport(store, edited, false)
    expect(third).toMatchObject({ added: 0, updated: 1, unchanged: 6 })
    expect(await store.get('memory', rowIdFor('m_1'))).toMatchObject({ pinned: true, body: 'CEO of Guavas. Final sign-off on positioning and pricing.' })

    // A page the person deleted here stays deleted on the next import.
    await store.remove('memory', rowIdFor('m_5'))
    const fourth = await runImport(store, exportFile, false)
    expect(fourth).toMatchObject({ added: 0, deletedHere: 1 })
    expect(fourth.message).toContain('1 deleted here, left alone')
    expect(await store.get('memory', rowIdFor('m_5'))).toBeNull()

    const everything = await runImport(store, exportFile, true)
    expect(everything.added).toBe(3)
    expect(everything.deletedHere).toBe(1)
    expect(await store.list('memory')).toHaveLength(9)
  })

  it('says plainly when a file is not an export', () => {
    expect(() => parseExport('not json')).toThrow('not JSON')
    expect(() => parseExport('{"hello":1}')).toThrow('no list of memories')
  })

  // The real export of the A.O.S bank, when it has been made on this machine (.night is git-ignored).
  const real = join(__dirname, '../../../.night/memory-bank-export.json')
  it.skipIf(!existsSync(real))('imports the real memory bank export', async () => {
    const raw = readFileSync(real, 'utf8')
    const started = Date.now()
    const result = await runImport(store, raw, false)
    const ms = Date.now() - started
    console.log(`REAL IMPORT ${JSON.stringify({ byKind: result.byKind, added: result.added, skippedRetired: result.skippedRetired, skippedTransient: result.skippedTransient, invalid: result.invalid, redacted: result.redacted, ms })}`)
    expect(result.added).toBeGreaterThan(1000)
    const again = await runImport(store, raw, false)
    expect(again.added).toBe(0)
    expect(again.unchanged).toBe(result.added)
    const bodies = JSON.stringify(await store.list('memory'))
    expect(bodies).not.toMatch(/sk-ant-[A-Za-z0-9_-]{16}|AIza[0-9A-Za-z_-]{30}|ghp_[A-Za-z0-9]{30}/)
  }, 120_000)
})
