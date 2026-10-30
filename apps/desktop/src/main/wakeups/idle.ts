/**
 * Whether this computer is idle or locked (Settings > Wake-ups: only the phone when this computer is idle or locked).
 * The threshold is a setting. A failed read says unknown, which counts as active: when in doubt it rings.
 *
 * AGENT_WAKEUP_PROOF_IDLE (test copies only, with AGENT_WAKEUP_PROOF=1): a file holding active, idle or locked stands in
 * for the real state, because a proof cannot walk away from the keyboard of the machine it runs on.
 */
import { readFileSync } from 'node:fs'
import { powerMonitor } from 'electron'

import type { IdleState } from '../../shared/wakeups'

export function wakeIdleState(settings: { get(): { wakeupsIdleMinutes: number } }, env: NodeJS.ProcessEnv = process.env): () => IdleState {
  const file = env['AGENT_WAKEUP_PROOF'] === '1' ? (env['AGENT_WAKEUP_PROOF_IDLE'] ?? '') : ''
  return () => {
    if (file !== '') {
      try {
        const text = readFileSync(file, 'utf8').trim()
        if (text === 'active' || text === 'idle' || text === 'locked') return text
      } catch {
        // No file: the real state.
      }
    }
    try {
      return powerMonitor.getSystemIdleState(Math.max(60, Math.round(settings.get().wakeupsIdleMinutes * 60)))
    } catch {
      return 'unknown'
    }
  }
}
