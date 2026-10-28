/**
 * Background scripts (run_script with background true) as runs the person can see and stop (28 Oct 2026: one kept
 * opening TikTok tabs every half minute after the run that started it was gone, with nothing on screen and no way to
 * stop it but stopping everything).
 *
 * Each one gets a working card in the main chat (scr-<id>, a helper row, so the sidebar shows it with its stop),
 * a place in the live runs (helpers_status, helper_stop, Stop all, the browser's tab owners), and it ends with the
 * routine or helper that started it.
 */
import { onBackgroundScript, stopScriptsOf, type BackgroundScript } from '@agent/core'

function parseMeta(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

import { onRunEnded } from '../browser/run-tabs'
import type { DataStore } from './data'
import { liveRuns } from './live-runs'

export const scriptCardId = (id: string): string => `scr-${id}`

/** Who started it, in plain words. */
function whose(script: BackgroundScript): string {
  if (script.owner === 'routine') return 'a routine'
  if (script.owner.startsWith('helper:')) return script.label === '' ? 'a helper' : script.label
  if (script.owner === 'main') return 'the main agent'
  if (script.owner.startsWith('chat:')) return 'a project chat'
  return script.label || script.owner
}

/** Starts watching. Returns the way to stop watching. */
export function watchBackgroundScripts(store: DataStore, changed: () => void, now: () => number = Date.now): () => void {
  const offScripts = onBackgroundScript((script) => {
    const id = scriptCardId(script.id)
    const label = `Background script for ${whose(script)}`
    let stoppedBy = ''
    const live = liveRuns.start({
      id,
      kind: 'script',
      label,
      owner: script.owner,
      startedAt: script.started,
      line: script.line,
      stop: (by) => {
        stoppedBy = by === '' ? 'it was stopped' : `stopped by ${by}`
        script.stop()
      },
    })
    const meta = { id, label, state: 'working', summary: script.line || 'Running', queued: false, startedAt: script.started, endedAt: null, result: '', script: { id: script.id, owner: script.owner } }
    void store
      .upsert('chat_item', { id, kind: 'helper', text: script.line || 'A background script', meta: JSON.stringify(meta), createdAt: script.started })
      .then(() => changed())
      .catch(() => undefined)
    void script.done.then(async (outcome) => {
      live.end()
      const state = stoppedBy !== '' ? 'stopped' : outcome.ok ? 'done' : 'failed'
      const result = stoppedBy !== '' ? `${stoppedBy.charAt(0).toUpperCase()}${stoppedBy.slice(1)}.` : outcome.ok ? (outcome.value ?? 'Done.') : outcome.timedOut === true ? 'It ran out of time.' : (outcome.error ?? 'It failed.')
      const row = await store.get('chat_item', id).catch(() => null)
      const before = row === null ? meta : parseMeta(row.meta)
      await store
        .upsert('chat_item', { id, kind: 'helper', text: row?.text ?? script.line, meta: JSON.stringify({ ...before, state, summary: result.slice(0, 140), result: result.slice(0, 2000), endedAt: now() }) })
        .catch(() => undefined)
      changed()
    })
  })
  // A routine's or a helper's scripts end with it; the main agent's and a chat's carry on (they show and can be
  // stopped), as a person asked for a long job there.
  const offRuns = onRunEnded((owner) => {
    if (owner === 'routine' || owner.startsWith('helper:')) stopScriptsOf(owner)
  })
  return () => {
    offScripts()
    offRuns()
  }
}
