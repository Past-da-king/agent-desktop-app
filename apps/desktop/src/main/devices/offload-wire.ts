/**
 * Offload wired into a running app (docs/devices-protocol.md s12): one place for the desktop app and the headless
 * node. It makes the Offload (runtime/offload.ts), gives the helper manager its link, answers the messages other
 * brains send here, and wraps the chat runner so a project chat placed on another brain behaves here as if it ran
 * here (sending, stopping, its running state).
 *
 * Off (no effect at all) while Devices is off, and while no other brain beats a node row.
 */
import { MAIN_CHAT, accountsOf, resolvePick, type AiAccount, type ChatEvent, type ChatItem, type ChatRunInfo, type DataChange, type JobRow, type ProjectRow, type RunState, type Settings, type TriggerRow, type TurnLeaseRow } from '@agent/core'

import { brainFor, isBrain, type ProviderFactory } from '../runtime/brains'
import type { HelperManager, OffloadLink } from '../runtime/helpers'
import { DEFAULT_JOB_CAP, Offload, TAKE_BACK_MS, type NodeCapacity, type PlaceResult } from '../runtime/offload'
import type { ChatVia } from '../tools/projects'
import { devicesState, ownBrainIds } from './sync'

/** How long an AI account that failed to sign in here is left out of this brain's offer. */
const CANNOT_RUN_MS = 6 * 3_600_000
const CANNOT_KEY = 'offload_cannot_run'

type ReplicaStore = ConstructorParameters<typeof Offload>[0]['store'] & {
  deviceId: string
  localValue(key: string): string | null
  setLocalValue(key: string, value: string): void
}

export interface OffloadRunner {
  send(text: string, attachments?: unknown[], chat?: string, origin?: never): Promise<void>
  receive(chat: string, text: string, via: ChatVia): Promise<void>
  stop(chat?: string): void
  state(chat?: string): RunState
}

export interface OffloadWireDeps {
  store: ReplicaStore
  helpers: HelperManager
  settings: { get(): Settings }
  secrets: { get(name: string): string | null }
  providerFactory: ProviderFactory
  /** Whether this build runs plans, and which ones are signed in here. */
  cli: { signedIn(cli: 'claude' | 'codex'): boolean } | null
  /** The chat runner, once made. */
  runner: () => OffloadRunner | null
  kind: 'desktop' | 'server'
  name: () => string
  browser: () => boolean
  /** A chat event for the window (a placed project chat started or finished elsewhere). */
  emitChat?: (event: ChatEvent) => void
  /** A question or approval from a helper running on another brain for this one: tell the person here. */
  needsYou?: (itemId: string, title: string, body: string) => void
  log?: (line: string, detail?: Record<string, unknown>) => void
}

export interface OffloadWire {
  offload: Offload
  link: OffloadLink
  /** A message for `chat` sent on another brain instead of here. True when it went there. */
  forward(chat: string, text: string, via: ChatVia | null): Promise<boolean>
  /** Where a new project chat runs (project_chat_start). */
  placeChat(chat: string, project: ProjectRow, brief: string, device?: string): Promise<PlaceResult | null>
  /** Whether this brain runs a due routine slot. */
  claimRoutine(trigger: TriggerRow): Promise<boolean>
  /** The chat runner as the window and other devices use it: placed chats go to their brain. */
  wrapRunner<T extends object>(runner: T): T
  /** A chat's state with what runs on other brains for it. */
  state(local: RunState, chat: string): RunState
  stop(): void
}

export function startOffload(deps: OffloadWireDeps): OffloadWire {
  const { store, helpers, settings } = deps
  const now = (): number => Date.now()
  const selfId = (): string => devicesState.sync?.selfId() ?? ''
  const isSelf = (id: string): boolean => id !== '' && (id === selfId() || ownBrainIds(store).includes(id))
  const reachable = (id: string): boolean => devicesState.sync?.replicator.status().some((link) => link.peer === id && link.ok) ?? false

  const cannot = new Map<string, number>()
  try {
    const saved = JSON.parse(store.localValue(CANNOT_KEY) ?? '{}') as Record<string, unknown>
    for (const [account, until] of Object.entries(saved)) if (typeof until === 'number' && until > now()) cannot.set(account, until)
  } catch {
    // Nothing remembered.
  }
  const canRun = (account: AiAccount): boolean => {
    if ((cannot.get(account.id) ?? 0) > now()) return false
    if (account.kind !== 'api') return deps.cli !== null && deps.cli.signedIn(account.kind)
    return isBrain(brainFor({ settings, secrets: deps.secrets, providerFactory: deps.providerFactory, hasCli: deps.cli !== null }, { account: account.id, model: '' }))
  }
  const capacity = (): NodeCapacity => {
    const cap = settings.get().devicesJobCap
    return {
      name: deps.name(),
      kind: deps.kind,
      accounts: accountsOf(settings.get()).filter(canRun).map((account) => account.id),
      cap: typeof cap === 'number' && Number.isFinite(cap) ? Math.max(0, Math.min(16, Math.round(cap))) : DEFAULT_JOB_CAP,
      active: helpers.activeCount(),
      browser: deps.browser(),
    }
  }

  // Project chats that run on another brain for this one, and whether a turn runs there now (their turn leases).
  const runningThere = new Set<string>()
  const placedChats = new Set<string>()
  /** Placed chats whose first turn has not shown its lease here yet, and since when (they count as running). */
  const starting = new Map<string, number>()
  const START_GRACE_MS = 60_000

  const handle = async (msg: JobRow): Promise<boolean> => {
    if (msg.op === 'post') {
      const runner = deps.runner()
      if (runner === null) return false
      let via: ChatVia | null = null
      try {
        via = msg.info === '' ? null : (JSON.parse(msg.info) as ChatVia)
      } catch {
        via = null
      }
      if (via === null) void runner.send(msg.text, [], msg.helper).catch(() => undefined)
      else void runner.receive(msg.helper, msg.text, via).catch(() => undefined)
      return true
    }
    if (msg.op === 'chatstop') {
      deps.runner()?.stop(msg.helper)
      return true
    }
    return helpers.onRemote(msg)
  }

  const offload = new Offload({
    store,
    selfId,
    isSelf,
    reachable,
    capacity,
    mode: () => settings.get().helpersRunOn || 'best',
    handle,
    ...(deps.log === undefined ? {} : { log: deps.log }),
  })

  const link: OffloadLink = {
    selfId,
    isSelf,
    up: (id) => offload.up(id),
    place: (req) => offload.place(req),
    send: (to, op, helper, extra) => offload.send(to, op, helper, extra),
    leaseHolder: (id) => offload.leaseHolder(id),
    deviceName: (id) => offload.deviceName(id),
    cannotRun: (account, why) => {
      cannot.set(account, now() + CANNOT_RUN_MS)
      store.setLocalValue(CANNOT_KEY, JSON.stringify(Object.fromEntries(cannot)))
      deps.log?.('This brain cannot run an AI account for now', { account, why: why.slice(0, 120) })
      void offload.beat().catch(() => undefined)
    },
  }
  helpers.setOffload(link)

  // A start nobody took is run here; a placed chat's turn shows as running here.
  const takeBack = setInterval(() => void helpers.takeBack(TAKE_BACK_MS).catch(() => 0), 10_000)
  takeBack.unref?.()
  const offLeases = store.onChange((change: DataChange) => {
    if (change.entity !== 'turn_lease' || change.row === undefined) return
    const lease = change.row as TurnLeaseRow
    if (lease.kind !== 'turn' || lease.chatId === MAIN_CHAT || isSelf(lease.brainId) || !placedChats.has(lease.chatId)) return
    const running = lease.status === 'running'
    starting.delete(lease.chatId)
    if (running && !runningThere.has(lease.chatId)) {
      runningThere.add(lease.chatId)
      deps.emitChat?.({ type: 'run_started', chat: lease.chatId })
    } else if (!running && runningThere.delete(lease.chatId)) {
      deps.emitChat?.({ type: 'run_finished', chat: lease.chatId })
    }
  })
  // A card asked by a helper this brain placed elsewhere arrives by replication: the person hears it here.
  const told = new Set<string>()
  const offCards = store.onChange((change: DataChange) => {
    if (change.entity !== 'chat_item' || change.row === undefined) return
    const row = change.row as ChatItem
    if ((row.kind !== 'question' && row.kind !== 'approval') || told.has(row.id)) return
    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse(row.meta) as Record<string, unknown>
    } catch {
      return
    }
    const helper = typeof meta['helper'] === 'string' ? meta['helper'] : ''
    const open = row.kind === 'question' ? (meta['answer'] ?? '') === '' : (meta['decision'] ?? '') === ''
    if (helper === '' || !open || !helpers.isPlacedElsewhere(helper)) return
    told.add(row.id)
    const chat = typeof meta['chat'] === 'string' && meta['chat'] !== '' ? meta['chat'] : undefined
    deps.emitChat?.({ type: 'needs_you', itemId: row.id, ...(chat === undefined ? {} : { chat }) })
    const by = typeof meta['by'] === 'string' && meta['by'] !== '' ? meta['by'] : 'A helper'
    deps.needsYou?.(row.id, row.kind === 'question' ? `${by} has a question` : `${by} needs your OK`, row.text.slice(0, 200))
  })
  offload.start()

  const forward = async (chat: string, text: string, via: ChatVia | null): Promise<boolean> => {
    const to = await offload.routeChat(chat, via?.from === 'project' ? via.chat : undefined)
    if (to === null) return false
    if (chat !== MAIN_CHAT) {
      placedChats.add(chat)
      starting.set(chat, now())
    }
    await offload.send(to, 'post', chat, { text, info: via === null ? '' : JSON.stringify(via) })
    return true
  }

  const startingNow = (chat: string): boolean => {
    const since = starting.get(chat)
    if (since === undefined) return false
    if (now() - since < START_GRACE_MS) return true
    starting.delete(chat)
    return false
  }
  const state = (local: RunState, chat: string): RunState => ((runningThere.has(chat) || startingNow(chat)) && !local.running ? { ...local, running: true } : local)

  return {
    offload,
    link,
    forward,
    placeChat: async (chat, project, brief, device) => {
      if (selfId() === '') return null
      const pick = resolvePick(settings.get(), project.ai, 'main')
      const placed = await offload.place({ text: brief, account: pick.account, ...(device === undefined ? {} : { device }), localFolder: (project.path ?? '') !== '' })
      if (placed.device !== null) {
        await offload.placeChat(chat, placed.device)
        placedChats.add(chat)
      }
      return placed
    },
    claimRoutine: async (trigger) => {
      const pick = resolvePick(settings.get(), undefined, 'main')
      return offload.claimRoutine(trigger.id, String(trigger.lastRunAt ?? 0), { text: `${trigger.name}\n${trigger.prompt}`, account: pick.account, ...(trigger.device === undefined || trigger.device === '' ? {} : { device: trigger.device }) })
    },
    wrapRunner: <T extends object>(runner: T): T =>
      new Proxy(runner, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown
          if (prop === 'send' && typeof value === 'function') {
            return async (text: string, attachments?: unknown[], chat?: string, origin?: unknown) => {
              if ((attachments ?? []).length === 0 && chat !== undefined && chat !== MAIN_CHAT && (await forward(chat, text, null))) return
              return (value as (...args: unknown[]) => Promise<void>).call(target, text, attachments, chat, origin)
            }
          }
          if (prop === 'stop' && typeof value === 'function') {
            return (chat?: string) => {
              if (chat !== undefined && chat !== MAIN_CHAT) {
                void offload.routeChat(chat).then((to) => (to === null ? undefined : offload.send(to, 'chatstop', chat))).catch(() => undefined)
              }
              return (value as (chat?: string) => void).call(target, chat)
            }
          }
          if (prop === 'state' && typeof value === 'function') {
            return (chat?: string) => {
              const local = (value as (chat?: string) => RunState).call(target, chat)
              return chat === undefined ? local : state(local, chat)
            }
          }
          if (prop === 'states' && typeof value === 'function') {
            return () => {
              const local = (value as () => ChatRunInfo[]).call(target)
              const extra = [...runningThere].filter((chat) => !local.some((info) => info.chat === chat)).map((chat) => ({ chat, running: true, waiting: [], alongside: 0 }))
              return [...local.map((info) => (runningThere.has(info.chat) ? { ...info, running: true } : info)), ...extra]
            }
          }
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
        },
      }),
    state,
    stop: () => {
      clearInterval(takeBack)
      offLeases()
      offCards()
      offload.stop()
      helpers.setOffload(null)
    },
  }
}
