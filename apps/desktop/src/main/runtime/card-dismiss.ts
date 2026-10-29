/**
 * A card's X on the desktop and a swipe on the phone (RPC `helpers.dismiss`): the card stops what it stands for if it
 * is still working, and leaves the list. Nothing is deleted: the chat, the helper's row and its result stay.
 *  - a project chat's card: its run is stopped, a row left marked working with no run behind it is ended, and the
 *    card is closed on its project row (`panelHidden`) until that chat moves again;
 *  - a helper's card: the helper is stopped (a card whose run is gone is ended as lost), and its row is stamped
 *    `cardClosedAt`, so the finished card does not stay under its project chat.
 * Both stamps live on synced rows, so the card leaves every device and stays gone after a restart.
 */
import type { ChatItem, HelperCardInfo, ProjectRow } from '@agent/core'

import { closePatch } from '../../shared/helper-cards'

export interface CardDismissDeps {
  get: (id: string) => Promise<ChatItem | null>
  upsertItem: (patch: { id: string; kind: string; text: string; meta: string }) => Promise<unknown>
  projects: () => Promise<ProjectRow[]>
  upsertProject: (patch: { id: string; panelHidden: Record<string, number> }) => Promise<unknown>
  /** The cards as the side panel builds them now. */
  cards: () => Promise<HelperCardInfo[]>
  stopHelper: (id: string) => Promise<boolean>
  stopChat: (chat: string) => void
  chatRunning: (chat: string) => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type DismissResult = { ok: true; stopped: boolean } | { ok: false; why: string }

function parse(meta: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(meta)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const SETTLE_MS = 5000
const STEP_MS = 100

export async function dismissCard(ref: string, deps: CardDismissDeps): Promise<DismissResult> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const cards = await deps.cards()
  const card = cards.find((each) => each.id === ref || each.row === ref)
  // A card the list no longer has may still be a row (an older phone's list): it is judged by its row.
  const rowId = card?.row ?? ref
  const row = await deps.get(rowId)
  const projectChat = card?.projectChat || (row === null ? '' : String(parse(row.meta)['projectChat'] ?? ''))
  if (card === undefined && row === null) return { ok: false, why: 'There is no such card.' }

  if (projectChat !== '') {
    let stopped = false
    if (deps.chatRunning(projectChat)) {
      deps.stopChat(projectChat)
      stopped = true
      for (let waited = 0; waited < SETTLE_MS && deps.chatRunning(projectChat); waited += STEP_MS) await sleep(STEP_MS)
    }
    // Its row says working with nothing running (a restart, a brain that went away): it is ended, not left working.
    const fresh = row === null ? null : await deps.get(row.id)
    if (fresh !== null) {
      const meta = parse(fresh.meta)
      if (meta['state'] === 'working' && !deps.chatRunning(projectChat)) {
        await deps.upsertItem({ id: fresh.id, kind: fresh.kind, text: fresh.text, meta: JSON.stringify({ ...meta, state: 'stopped', summary: 'Stopped', endedAt: now(), queued: false }) })
        stopped = true
      }
    }
    const project = (await deps.projects()).find((each) => each.chats.includes(projectChat))
    if (project !== undefined) {
      // Stamped after the stop has landed, so the stop's own lines do not bring the card back.
      const latest = (await deps.cards()).find((each) => each.projectChat === projectChat)
      await deps.upsertProject({ id: project.id, panelHidden: closePatch(project, projectChat, Math.max(now(), latest?.activityAt ?? 0)) })
    }
    return { ok: true, stopped }
  }

  if (row === null || row.kind !== 'helper') return { ok: false, why: 'There is no such helper.' }
  let stopped = false
  if (parse(row.meta)['state'] === 'working') {
    stopped = await deps.stopHelper(row.id)
    for (let waited = 0; waited < SETTLE_MS; waited += STEP_MS) {
      const fresh = await deps.get(row.id)
      if (fresh === null || parse(fresh.meta)['state'] !== 'working') break
      await sleep(STEP_MS)
    }
  }
  const fresh = (await deps.get(row.id)) ?? row
  const meta = parse(fresh.meta)
  await deps.upsertItem({ id: fresh.id, kind: fresh.kind, text: fresh.text, meta: JSON.stringify({ ...meta, cardClosedAt: now() }) })
  return { ok: true, stopped }
}
