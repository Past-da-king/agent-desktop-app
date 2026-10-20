/**
 * Small pure helpers for profiles in Connections: each profile's colour as light and dark tones, and
 * the lines its row shows. The tones come from the app's own accents (state/theme.ts); graphite is the
 * neutral surface tokens. Nothing here invents a colour.
 */
import { GENERAL_PROFILE, PROFILE_COLORS, type AgentProfileInfo, type ConnectedAccount, type ProfileColor } from '@agent/core'

import { ACCENTS } from '../state/theme'

/** Solid swatch, container fill and the text on it, for one theme. */
export interface Tone {
  solid: string
  bg: string
  fg: string
}

export interface ProfileTones {
  light: Tone
  dark: Tone
}

/** Iris is the token default, so theme.ts carries no tuple for it: these are the values in tokens.css. */
const IRIS: ProfileTones = {
  light: { solid: '#4A3FD1', bg: '#E4E0FF', fg: '#1C1466' },
  dark: { solid: '#C3BBFF', bg: '#3A2FB0', fg: '#E7E3FF' },
}

/** The neutral profile (General by default) uses the surface-variant tokens, which switch with the theme. */
const GRAPHITE: ProfileTones = {
  light: { solid: 'var(--outline)', bg: 'var(--sv)', fg: 'var(--on-sv)' },
  dark: { solid: 'var(--outline)', bg: 'var(--sv)', fg: 'var(--on-sv)' },
}

export const COLOR_LABELS: Record<ProfileColor, string> = {
  ocean: 'Ocean',
  ember: 'Ember',
  violet: 'Violet',
  rose: 'Rose',
  teal: 'Teal',
  forest: 'Forest',
  magenta: 'Magenta',
  iris: 'Iris',
  graphite: 'Graphite',
}

export function isProfileColor(value: string): value is ProfileColor {
  return (PROFILE_COLORS as readonly string[]).includes(value)
}

export function profileTones(color: string): ProfileTones {
  if (color === 'graphite') return GRAPHITE
  if (color === 'iris') return IRIS
  const accent = ACCENTS.find((item) => item.id === color)
  if (accent?.light === undefined || accent.dark === undefined) return GRAPHITE
  const [lp, , lc, lon] = accent.light
  const [dp, , dc, don] = accent.dark
  return { light: { solid: lp, bg: lc, fg: lon }, dark: { solid: dp, bg: dc, fg: don } }
}

/** CSS variables for an element showing this profile; profiles.css picks the light or dark set. */
export function toneStyle(color: string): Record<string, string> {
  const t = profileTones(color)
  return {
    '--pf-solid-l': t.light.solid,
    '--pf-bg-l': t.light.bg,
    '--pf-fg-l': t.light.fg,
    '--pf-solid-d': t.dark.solid,
    '--pf-bg-d': t.dark.bg,
    '--pf-fg-d': t.dark.fg,
  }
}

export function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?'
}

/** General holds nothing and is never shown: the person only sees their own profiles. */
export function visibleProfiles(list: AgentProfileInfo[]): AgentProfileInfo[] {
  return list.filter((p) => !p.general)
}

/** "3 accounts · 1 learned app · its own browser sign-ins" under a profile's name. */
export function profileSummary(profile: AgentProfileInfo, all: AgentProfileInfo[]): string {
  const n = profile.accounts.length
  const l = profile.learned.length
  const parts = [n === 0 ? 'No accounts' : n === 1 ? '1 account' : `${n} accounts`]
  if (l > 0) parts.push(l === 1 ? '1 learned app' : `${l} learned apps`)
  const other = profile.browser === '' ? undefined : all.find((p) => p.id === profile.browser)
  parts.push(other === undefined ? 'its own browser sign-ins' : `browses as ${other.name}`)
  return parts.join(' · ')
}

export interface AppGroup {
  app: string
  appName: string
  logo: string
  accounts: ConnectedAccount[]
}

/** One group per app, apps by name, accounts by label: the compact list in Connections. */
export function groupAccounts(accounts: ConnectedAccount[]): AppGroup[] {
  const groups = new Map<string, AppGroup>()
  for (const account of accounts) {
    const group = groups.get(account.app) ?? { app: account.app, appName: account.appName, logo: '', accounts: [] }
    if (group.logo === '' && (account.logo ?? '') !== '') group.logo = account.logo ?? ''
    if (group.logo === '') group.logo = logoUrl(account.app)
    group.accounts.push(account)
    groups.set(account.app, group)
  }
  return [...groups.values()]
    .map((g) => ({ ...g, accounts: g.accounts.slice().sort((a, b) => accountLabel(a).localeCompare(accountLabel(b))) }))
    .sort((a, b) => a.appName.localeCompare(b.appName))
}

/** The accounts shown for a search and a chosen profile (null for all). */
export function filterAccounts(accounts: ConnectedAccount[], query: string, profile: AgentProfileInfo | null): ConnectedAccount[] {
  const q = query.trim().toLowerCase()
  return accounts.filter((a) => {
    if (profile !== null && !profile.accounts.some((m) => m.id === a.id)) return false
    if (q === '') return true
    return a.appName.toLowerCase().includes(q) || a.app.includes(q) || a.label.toLowerCase().includes(q)
  })
}

/** The profiles an account belongs to (General never holds accounts). */
export function profilesWith(accountId: string, list: AgentProfileInfo[]): AgentProfileInfo[] {
  return list.filter((p) => !p.general && p.accounts.some((a) => a.id === accountId))
}

/** The account's own words for who it is, falling back to the app name. */
export function accountLabel(account: Pick<ConnectedAccount, 'label' | 'appName'>): string {
  const label = account.label.trim()
  return label === '' || label === account.appName ? account.appName : label
}

/** The next colour no profile has yet, like the phone's nextColor. */
export function nextColor(list: AgentProfileInfo[]): ProfileColor {
  return PROFILE_COLORS.find((c) => c !== 'graphite' && !list.some((p) => p.color === c)) ?? 'iris'
}

export function isGeneralName(name: string): boolean {
  return name.trim().toLowerCase() === GENERAL_PROFILE.toLowerCase()
}

/** The connect list: matches by name, slug, line or category, capped so hundreds of apps stay quick. */
export function searchCatalog<T extends { slug: string; name: string; line: string; categories?: string[] }>(
  list: T[],
  query: string,
  limit = 60,
): { shown: T[]; total: number } {
  const q = query.trim().toLowerCase()
  const hits =
    q === ''
      ? list
      : list.filter(
          (item) =>
            item.name.toLowerCase().includes(q) ||
            item.slug.includes(q) ||
            item.line.toLowerCase().includes(q) ||
            (item.categories ?? []).some((c) => c.toLowerCase().includes(q)),
        )
  // Names that start with the query first, so "out" finds Outlook before Shoutout.
  const ranked = q === '' ? hits : [...hits].sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
  return { shown: ranked.slice(0, limit), total: hits.length }
}

/** Composio's logo for an app slug: the same service the main process falls back to, so every screen shows one. */
export function logoUrl(slug: string): string {
  const clean = slug.trim().toLowerCase()
  return /^[a-z0-9_]{2,60}$/.test(clean) ? `https://logos.composio.dev/api/${clean}` : ''
}
