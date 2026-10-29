/**
 * Mini-apps show in Ctrl+K search (29 Oct 2026): "calendar" lists his Calendar app first, so Enter opens it; it is
 * found by its name, the other names it was given and its description, and drawn with its own icon.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { findMatches, projectFields, type FindField } from '@agent/core'

import { Store } from '../src/main/db'
import { MiniAppStore } from '../src/main/miniapps/store'
import { miniAppFields } from '../src/shared/miniapps'

type Item = { kind: 'project' | 'app' | 'page'; name: string; fields: FindField[] }

const project = (name: string, description = '', aliases: string[] = []): Item => ({
  kind: 'project',
  name,
  fields: [...projectFields({ name, description, aliases, path: '' }), { text: 'project', weight: 0.3, fuzzy: false }],
})
const app = (name: string, description: string, aliases?: string[]): Item => ({ kind: 'app', name, fields: miniAppFields({ name, description, ...(aliases ? { aliases } : {}) }) })
const page = (name: string): Item => ({ kind: 'page', name, fields: [{ text: name, weight: 1 }] })

// What his palette holds: the pages, his projects (one mentions meetings), and his mini-apps.
const ITEMS: Item[] = [
  page('Home'),
  page('Chat'),
  page('Tasks'),
  page('Routines'),
  project('Agent Desktop App', 'His agent app: calendar view, meetings and wake-ups'),
  project('Cosmiprint', 'Star signs web app'),
  project('Impetix'),
  app('Plan tracker', 'Ticks off the plan'),
  app('Calendar', 'His week of meetings from every calendar', ['diary', 'schedule']),
]

const top = (query: string): Item | undefined => findMatches(query, ITEMS.map((item) => ({ item, fields: item.fields })))[0]?.item

describe('mini-apps in Ctrl+K search', () => {
  it('"calendar" puts his Calendar app first, ahead of a project that only mentions a calendar', () => {
    expect(top('calendar')).toMatchObject({ kind: 'app', name: 'Calendar' })
    expect(top('cal')).toMatchObject({ kind: 'app', name: 'Calendar' })
    expect(top('calender')).toMatchObject({ kind: 'app', name: 'Calendar' })
    expect(top('open my calendar')).toMatchObject({ kind: 'app', name: 'Calendar' })
  })

  it('finds an app by another name and by its description', () => {
    expect(top('diary')).toMatchObject({ name: 'Calendar' })
    expect(top('ticks off')).toMatchObject({ name: 'Plan tracker' })
    const apps = findMatches('apps', ITEMS.map((item) => ({ item, fields: item.fields }))).map((hit) => hit.item.name)
    expect(apps).toEqual(expect.arrayContaining(['Calendar', 'Plan tracker']))
  })

  it('ignores aliases that are not strings (a row from another build)', () => {
    expect(miniAppFields({ name: 'X', description: '', aliases: [3, null, 'Y'] as unknown as string[] }).map((field) => field.text)).toEqual(['X', 'Y', '', 'app apps mini-app'])
  })

  it('the palette lists every mini-app with its own icon and opens it on Enter', () => {
    const source = readFileSync(join(__dirname, '../src/renderer/shell/Palette.tsx'), 'utf8')
    expect(source).toContain("useEntity('miniapp')")
    expect(source).toContain('miniAppFields(app)')
    expect(source).toContain('<MiniAppIcon icon={app.icon}')
    expect(source).toContain("navigate({ page: 'miniapp', id: app.id })")
  })

  it('an agent can give an app other names, without making a new version', async () => {
    let t = 1000
    const store = new Store(':memory:', () => t)
    const apps = new MiniAppStore({ store, now: () => t })
    const made = await apps.create(
      { name: 'Calendar', description: 'His week', icon: 'clock', files: { 'index.html': '<main class="card">Week</main>' }, aliases: ['diary', ' diary ', ''] },
      { by: 'agent', profile: '' },
    )
    if (!made.ok) throw new Error(made.why)
    expect(made.app.aliases).toEqual(['diary'])
    t += 1
    const renamed = await apps.update(made.app.id, { aliases: ['diary', 'schedule'] }, { by: 'agent', reason: 'search names' })
    if (!renamed.ok) throw new Error(renamed.why)
    expect(renamed.app.aliases).toEqual(['diary', 'schedule'])
    expect(renamed.app.version).toBe(1)
  })
})
