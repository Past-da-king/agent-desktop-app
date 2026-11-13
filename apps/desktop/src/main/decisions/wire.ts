/**
 * The one place that builds the decision service from the app's own parts (settings, secrets, the normal model) and the two
 * hooks that use it: the desk triage and the routine delta check. Shared by the desktop app and the headless node.
 */
import type { Settings, TriggerRow, WorkerEvent } from '@agent/core'

import type { DeskTriage } from '../workers/router'
import { resolveDecisionKeys, type SecretReader } from './keys'
import { routineDeltaCheck, triageDeskBatch, type DeltaVerdict } from './precheck'
import type { Complete } from './providers/llm'
import { DecisionService } from './service'

export interface DecisionWireDeps {
  settings: () => Settings
  secrets: SecretReader
  /** The app's own model for one question set; null while there is none yet. */
  complete: () => Complete | null
  /** Event store, for the routine delta check; null while there is none. */
  events: () => { events(options?: { limit?: number }): WorkerEvent[] } | null
  log: (message: string, fields: Record<string, string | number | boolean>) => void
}

const CHANGE_CHARS = 300
const MAX_CHANGES = 40

/** What reached the app since the routine last ran (worker events), or null when this app cannot tell. */
export function changesSince(store: { events(options?: { limit?: number }): WorkerEvent[] } | null, lastRunAt: number | null): string | null {
  if (store === null || lastRunAt === null) return null
  const fresh = store.events({ limit: 200 }).filter((event) => event.receivedAt > lastRunAt).slice(0, MAX_CHANGES)
  return fresh.map((event) => event.source + ' / ' + event.event + ': ' + (event.payload.length <= CHANGE_CHARS ? event.payload : event.payload.slice(0, CHANGE_CHARS) + '...')).join('\n')
}

export interface DecisionWire {
  service: DecisionService
  triage: DeskTriage
  precheck: (trigger: TriggerRow) => Promise<DeltaVerdict>
}

export function wireDecisions(deps: DecisionWireDeps): DecisionWire {
  const service = new DecisionService({
    settings: () => {
      const s = deps.settings()
      return { enabled: s.decisionsEnabled, backend: s.decisionsBackend, threshold: s.decisionsThreshold }
    },
    keys: resolveDecisionKeys(deps.secrets, deps.settings),
    complete: deps.complete,
    log: deps.log,
  })
  return {
    service,
    triage: (trigger, batch) => triageDeskBatch(service, trigger, batch),
    precheck: (trigger) => routineDeltaCheck(service, trigger, service.enabled() ? changesSince(deps.events(), trigger.lastRunAt) : null),
  }
}
