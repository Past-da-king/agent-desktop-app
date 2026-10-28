/**
 * Chats from the days of several chats at once (ids "c...", before projects) are kept under one hidden project,
 * "Earlier chats", so nothing is lost; untagged rows stay in the main thread. Runs at every start and only adds
 * chats no project holds yet. A person who deleted that project keeps it deleted.
 */
import { EARLIER_CHATS_PROJECT } from '@agent/core'

import { listWhere, type DataStore } from '../runtime/data'
import { chatOf } from '../runtime/chat-lines'

export async function adoptEarlierChats(store: DataStore, deleted: boolean): Promise<number> {
  if (deleted) return 0
  // Every chat has rows other than steps: those are enough to know its chats, by index (not the 240 MB of steps).
  const rows = await listWhere(store, 'chat_item', { exceptKinds: ['activity'] })
  const projects = await store.list('project')
  const held = new Set(projects.flatMap((project) => project.chats))
  const firstSeen = new Map<string, number>()
  for (const row of rows) {
    const chat = chatOf(row)
    if (!/^c[a-z0-9]{6,40}$/i.test(chat) || held.has(chat)) continue
    firstSeen.set(chat, Math.min(firstSeen.get(chat) ?? row.createdAt, row.createdAt))
  }
  if (firstSeen.size === 0) return 0
  const orphans = [...firstSeen.entries()].sort((a, b) => a[1] - b[1]).map(([chat]) => chat)
  const existing = projects.find((project) => project.id === EARLIER_CHATS_PROJECT)
  if (existing !== undefined) {
    await store.upsert('project', { id: existing.id, chats: [...existing.chats, ...orphans] })
  } else {
    await store.upsert('project', {
      id: EARLIER_CHATS_PROJECT,
      name: 'Earlier chats',
      description: 'Chats from before projects. Nothing was lost.',
      icon: { glyph: 'clock', color: 'graphite' },
      path: '',
      profile: '',
      hidden: true,
      chats: orphans,
    })
  }
  return orphans.length
}
