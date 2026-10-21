/**
 * The browser's profiles as the person sees them, like Chrome's profile menu: their own (Mine), the one agents
 * share by default (General), and each agent profile with sign-ins of its own. Each is one Electron partition, so
 * a Google account signed in to one is invisible to the others. A profile that borrows another's sign-ins is not
 * listed on its own; it shows under the one it borrows from.
 */
import type { AgentProfileInfo, BrowserPerson, ProfileColor } from '@agent/core'

import { BASE_PARTITION, GENERAL_ID, MINE_ID, MINE_PARTITION, partitionFor } from '../apps/profiles'

export interface PeopleSource {
  profiles(): AgentProfileInfo[]
  /** The partition the person's own tabs open in now. */
  personPartition(): string
  /** Google accounts signed in to a partition; [] when none or unknown. */
  googleAccounts(partition: string): Promise<string[]>
}

const MINE_COLOR: ProfileColor = 'graphite'

export async function listPeople(source: PeopleSource): Promise<BrowserPerson[]> {
  const profiles = source.profiles()
  const own = profiles.filter((p) => !p.general && p.browser === '')
  const usedBy = (id: string): string[] =>
    profiles.filter((p) => !p.general && (p.id === id ? p.browser === '' : p.browser === id)).map((p) => p.name)
  const base: Array<Omit<BrowserPerson, 'google' | 'current'>> = [
    { id: MINE_ID, name: 'Mine', color: MINE_COLOR, kind: 'mine', partition: MINE_PARTITION, usedBy: usedBy(MINE_ID) },
    { id: GENERAL_ID, name: 'Agents', color: 'graphite', kind: 'shared', partition: BASE_PARTITION, usedBy: ['The main agent', 'Routines'] },
    ...own.map((p) => ({ id: p.id, name: p.name, color: p.color, kind: 'profile' as const, partition: partitionFor(p.id), usedBy: usedBy(p.id) })),
  ]
  const current = source.personPartition()
  return Promise.all(
    base.map(async (person) => ({ ...person, current: person.partition === current, google: await source.googleAccounts(person.partition).catch(() => []) })),
  )
}

/** The partition of a listed person id (Mine, General or a profile). */
export function partitionOfPerson(id: string): string {
  return id === MINE_ID ? MINE_PARTITION : partitionFor(id)
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/**
 * The addresses in Google's own ListAccounts answer (what Chrome reads for its account menu). Only signed-in
 * accounts appear in it; a signed-out session answers with none.
 */
export function emailsIn(body: string): string[] {
  return [...new Set((body.match(EMAIL) ?? []).map((email) => email.toLowerCase()))]
}
