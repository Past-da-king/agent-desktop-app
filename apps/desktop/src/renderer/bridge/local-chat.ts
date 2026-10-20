import type { AgentApi, ChatEvent, ChatItem, Decision, RowInput, Unsubscribe } from '@agent/core'

import { parseMeta } from '../lib/meta'

/**
 * Until the real agent runner lands (M6), the desktop still echoes like the mockup. In the browser
 * the in-memory mock already does that. Inside Electron the data store is real, so this adapter
 * writes the same chat rows through `AgentApi.data` instead of touching the unimplemented runner.
 */
export function localChat(api: AgentApi): AgentApi['chat'] {
  const listeners = new Set<(event: ChatEvent) => void>()
  let running = false
  let replyTimer: ReturnType<typeof setTimeout> | null = null
  let activityTimer: ReturnType<typeof setTimeout> | null = null

  const emit = (event: ChatEvent): void => {
    for (const listener of listeners) listener(event)
  }

  const insert = async (kind: string, text: string, meta: string): Promise<void> => {
    const row: RowInput<'chat_item'> = { kind, text, meta }
    await api.data.upsert('chat_item', row)
    emit({ type: 'chat_changed' })
  }

  const clearTimers = (): void => {
    if (replyTimer) clearTimeout(replyTimer)
    if (activityTimer) clearTimeout(activityTimer)
    replyTimer = null
    activityTimer = null
  }

  const loadCards = async (): Promise<ChatItem[]> => {
    try {
      return await api.data.list('chat_item')
    } catch {
      return []
    }
  }

  const patchCard = async (id: string, patch: Record<string, unknown>): Promise<void> => {
    const rows = await loadCards()
    const current = rows.find((item) => item.id === id)
    if (!current) return
    const meta = { ...parseMeta(current.meta), ...patch }
    await api.data.upsert('chat_item', { ...current, meta: JSON.stringify(meta) } as RowInput<'chat_item'>)
    emit({ type: 'chat_changed' })
  }

  return {
    async send(text, attachments) {
      const value = text.trim()
      if (value === '') return
      await insert('user', value, JSON.stringify({ attachments: attachments?.length ?? 0 }))
      running = true
      emit({ type: 'run_started' })
      emit({ type: 'thinking', step: 1 })
      clearTimers()
      activityTimer = setTimeout(() => {
        void insert(
          'activity',
          'Searched memory, 1 found',
          JSON.stringify({ tool: 'memory_search', status: 'done', summary: 'Searched memory, 1 found' }),
        )
      }, 300)
      replyTimer = setTimeout(() => {
        void insert(
          'agent',
          "Got it. I've added that to the current goal and I'll tell you as soon as it's done. Anything that spends money still waits for your OK.",
          '{}',
        ).finally(() => {
          running = false
          replyTimer = null
          activityTimer = null
          emit({ type: 'run_finished' })
        })
      }, 800)
    },
    async stop() {
      if (!running) return
      clearTimers()
      running = false
      await insert('notice', 'Stopped', '{}')
      emit({ type: 'run_finished' })
    },
    async state() {
      const rows = await loadCards()
      const waiting = rows
        .filter((item) => {
          if (item.kind !== 'question' && item.kind !== 'approval') return false
          const meta = parseMeta(item.meta)
          if (item.kind === 'question') return typeof meta['answer'] !== 'string' || meta['answer'] === ''
          return meta['decision'] !== 'approve' && meta['decision'] !== 'decline'
        })
        .map((item) => item.id)
      return { running, waiting }
    },
    async answer(itemId, answer) {
      await patchCard(itemId, { answer })
    },
    async decide(itemId, decision: Decision) {
      await patchCard(itemId, { decision })
    },
    onEvent(callback: (event: ChatEvent) => void): Unsubscribe {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
  }
}
