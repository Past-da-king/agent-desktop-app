/**
 * Browser profiles, like Chrome's: the person's own sign-ins (Mine) are apart from every agent's. An agent only
 * browses with them when the person lends them to a profile on purpose.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { BASE_PARTITION, MINE_PARTITION, ProfileStore } from '../src/main/apps/profiles'
import { emailsIn, listPeople, partitionOfPerson } from '../src/main/browser/people'
import { SiteStore } from '../src/main/browser/sites'

function store(): ProfileStore {
  return new ProfileStore(join(mkdtempSync(join(tmpdir(), 'people-')), 'profiles.json'))
}

describe('browser profiles', () => {
  it('lists Mine, the agents\' shared one and each profile with its own sign-ins, with who uses each', async () => {
    const profiles = store()
    const made = profiles.create('Work')
    if (!made.ok) throw new Error(made.message)
    const work = made.value
    profiles.create('Bookkeeping', [], undefined, work.id)
    const people = await listPeople({
      profiles: () => profiles.all(),
      personPartition: () => MINE_PARTITION,
      googleAccounts: async (partition) => (partition === MINE_PARTITION ? ['me@example.com'] : []),
    })
    expect(people.map((p) => [p.id, p.kind, p.current])).toEqual([
      ['mine', 'mine', true],
      ['general', 'shared', false],
      [work.id, 'profile', false],
    ])
    expect(people[0]?.google).toEqual(['me@example.com'])
    expect(people[0]?.usedBy).toEqual([])
    // A profile that borrows Work's sign-ins shows under Work, not on its own.
    expect(people[2]?.usedBy).toEqual(['Work', 'Bookkeeping'])
    expect(partitionOfPerson('mine')).toBe(MINE_PARTITION)
    expect(partitionOfPerson('general')).toBe(BASE_PARTITION)
  })

  it('never gives an agent the person\'s sign-ins unless a profile is lent them', () => {
    const profiles = store()
    const made = profiles.create('Work')
    if (!made.ok) throw new Error(made.message)
    const work = made.value
    expect(profiles.partitionOf(work.id)).not.toBe(MINE_PARTITION)
    expect(profiles.partitionOf(null)).toBe(BASE_PARTITION)
    profiles.update(work.id, { browser: 'mine' })
    expect(profiles.partitionOf(work.id)).toBe(MINE_PARTITION)
    profiles.update(work.id, { browser: '' })
    expect(profiles.partitionOf(work.id)).not.toBe(MINE_PARTITION)
  })

  it('remembers which profile the person\'s tabs open in', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sites-')), 'browser-sites.json')
    const sites = new SiteStore(file)
    expect(sites.person()).toBeNull()
    sites.setPerson(MINE_PARTITION)
    expect(new SiteStore(file).person()).toBe(MINE_PARTITION)
  })

  it('reads the signed-in addresses out of Google\'s ListAccounts answer', () => {
    const answer = '["gaia.l.a.r",[["gaia.l.a",1,"Sam Example","Sam@Example.com","https://lh3.example/a.jpg",1,1,0],["gaia.l.a",1,"Sam Work","sam@work.example","https://lh3.example/b.jpg",1,1,0]]]'
    expect(emailsIn(answer)).toEqual(['sam@example.com', 'sam@work.example'])
    expect(emailsIn('["gaia.l.a.r",[]]')).toEqual([])
  })
})
