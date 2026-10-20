import { describe, expect, it } from 'vitest'

import { PROFILE_COLORS, type AgentProfileInfo, type ConnectedAccount } from '@agent/core'

import {
  filterAccounts,
  groupAccounts,
  nextColor,
  profileSummary,
  profileTones,
  searchCatalog,
  toneStyle,
  visibleProfiles,
} from '../src/renderer/lib/profiles'
import { ACCENTS } from '../src/renderer/state/theme'

function account(id: string, app: string, appName: string, label: string): ConnectedAccount {
  return { id, app, appName, label, status: 'active', rules: { read: 'allow', change: 'ask' } }
}

function profile(id: string, name: string, accountIds: string[], extra: Partial<AgentProfileInfo> = {}): AgentProfileInfo {
  return {
    id,
    name,
    color: 'ocean',
    accounts: accountIds.map((a) => ({ id: a, app: 'gmail', label: a })),
    learned: [],
    browser: '',
    general: false,
    ...extra,
  }
}

const accounts = [
  account('a1', 'gmail', 'Gmail', 'work@example.com'),
  account('a2', 'gmail', 'Gmail', 'home@example.org'),
  account('a3', 'slack', 'Slack', 'Studio workspace'),
  account('a4', 'github', 'GitHub', 'ana-codes'),
]

describe('profile colours', () => {
  it('takes every accent tone from the app theme, never a new colour', () => {
    for (const color of PROFILE_COLORS) {
      const t = profileTones(color)
      const accent = ACCENTS.find((a) => a.id === color)
      if (accent?.light !== undefined && accent.dark !== undefined) {
        expect(t.light).toEqual({ solid: accent.light[0], bg: accent.light[2], fg: accent.light[3] })
        expect(t.dark).toEqual({ solid: accent.dark[0], bg: accent.dark[2], fg: accent.dark[3] })
      }
    }
    expect(profileTones('graphite').light.bg).toBe('var(--sv)')
    expect(profileTones('nonsense').light.bg).toBe('var(--sv)')
  })

  it('writes both theme sets as CSS variables', () => {
    const style = toneStyle('ember')
    expect(Object.keys(style).sort()).toEqual(['--pf-bg-d', '--pf-bg-l', '--pf-fg-d', '--pf-fg-l', '--pf-solid-d', '--pf-solid-l'])
  })

  it('gives a new profile the first colour nobody has, never graphite', () => {
    expect(nextColor([])).toBe('ocean')
    expect(nextColor([profile('p1', 'Work', [], { color: 'ocean' }), profile('p2', 'Home', [], { color: 'ember' })])).toBe('violet')
  })
})

describe('profiles in Connections', () => {
  it('hides General everywhere', () => {
    const general = profile('g', 'General', [], { general: true, color: 'graphite' })
    expect(visibleProfiles([general, profile('p1', 'Work', [])]).map((p) => p.name)).toEqual(['Work'])
  })

  it('sums up a profile in one line', () => {
    const work = profile('p1', 'Work', ['a1', 'a3'], { learned: ['hn'] })
    const home = profile('p2', 'Home', [], { browser: 'p1' })
    expect(profileSummary(work, [work, home])).toBe('2 accounts · 1 learned app · its own browser sign-ins')
    expect(profileSummary(home, [work, home])).toBe('No accounts · browses as Work')
  })

  it('groups accounts one row per app, apps by name', () => {
    const groups = groupAccounts(accounts)
    expect(groups.map((g) => `${g.appName}:${g.accounts.length}`)).toEqual(['GitHub:1', 'Gmail:2', 'Slack:1'])
    expect(groups[1]?.accounts.map((a) => a.label)).toEqual(['home@example.org', 'work@example.com'])
  })

  it('filters by profile and by search together', () => {
    const work = profile('p1', 'Work', ['a1', 'a3'])
    expect(filterAccounts(accounts, '', work).map((a) => a.id)).toEqual(['a1', 'a3'])
    expect(filterAccounts(accounts, 'gmail', work).map((a) => a.id)).toEqual(['a1'])
    expect(filterAccounts(accounts, 'home', null).map((a) => a.id)).toEqual(['a2'])
  })

  it('caps the connect list and ranks names that start with the search first', () => {
    const list = Array.from({ length: 300 }, (_, i) => ({ slug: `app${i}`, name: `App ${i}`, line: 'Something' }))
    list.push({ slug: 'shoutout', name: 'Shoutout', line: 'Posts' }, { slug: 'outlook', name: 'Outlook', line: 'Mail' })
    const all = searchCatalog(list, '', 60)
    expect(all.shown).toHaveLength(60)
    expect(all.total).toBe(302)
    const out = searchCatalog(list, 'out')
    expect(out.shown.map((a) => a.slug)).toEqual(['outlook', 'shoutout'])
  })
})
