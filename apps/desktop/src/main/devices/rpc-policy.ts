/**
 * What another device may do through the generic data calls (data.upsert, data.remove) and which methods each of its
 * roles may reach (review finding S2, 14 Nov 2026).
 *
 * Before: any entity but `device` was accepted with any fields, so a paired device could rewrite approvals, helper and
 * turn rows, leases, wake-ups and mini-app files. Now:
 *  - DEFAULT DENY. Only the entities a person edits by hand are writable, each with a FIELD allowlist and a type for
 *    every field. A field the policy does not know is refused; a runtime field it knows (a routine's last run) is
 *    dropped, so a client that round-trips a whole row still works but can never move runtime state.
 *  - Decisions and runtime state never go through here. An approval is decided by chat.decide, a card tap by chat.tap,
 *    an answer by chat.answer, a wake-up by wakeups.*, a mini-app by the miniapps tools: each validates its own
 *    transition. chat_item, turn, device, device_command, turn_lease, job, wakeup and miniapp have no generic write.
 *  - ROLES. A device that is only `hands` (it lends its tools) may read and may not act for the person. Writing needs
 *    `screen` or `brain`. An unknown or taken-out device has no roles and may do nothing.
 */
import type { DeviceRole } from './types'

export const NOT_ALLOWED = 'not available on this device'

type Check = (value: unknown) => boolean

const MAX_TEXT = 200_000
const MAX_SHORT = 2_000
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str =
  (max: number = MAX_SHORT): Check =>
  (value) =>
    typeof value === 'string' && value.length <= max
const oneOf =
  (...allowed: string[]): Check =>
  (value) =>
    typeof value === 'string' && allowed.includes(value)
const bool: Check = (value) => typeof value === 'boolean'
const num: Check = (value) => typeof value === 'number' && Number.isFinite(value)
const orNull =
  (check: Check): Check =>
  (value) =>
    value === null || check(value)
const listOf =
  (check: Check, max = 500): Check =>
  (value) =>
    Array.isArray(value) && value.length <= max && value.every(check)
/** A plain object whose keys are all in `keys` and whose values pass. */
const shape =
  (fields: Record<string, Check>): Check =>
  (value) =>
    isObject(value) && Object.entries(value).every(([key, item]) => fields[key] !== undefined && fields[key](item))
const record = (valueCheck: Check, max = 500): Check => (value) => isObject(value) && Object.keys(value).length <= max && Object.values(value).every(valueCheck)

const pick = shape({ account: str(), model: str() })
const picks: Check = shape({ main: pick, helpers: pick })

interface EntityPolicy {
  /** Fields a device may write, each with its type check. */
  fields: Readonly<Record<string, Check>>
  /** Fields the row has but a device may never set: removed from what is saved, not an error. */
  readonly runtime?: readonly string[]
  /** May a device delete a row of this entity? */
  remove: boolean
}

const MEMORY_KINDS = ['fact', 'preference', 'person', 'decision', 'how-to', 'event', 'skill', 'organisation', 'project']

/** The user-editable objects, and nothing else. An entity that is not here has no generic write at all. */
export const WRITABLE: Readonly<Record<string, EntityPolicy>> = {
  task: {
    fields: {
      id: str(128),
      goalId: orNull(str(128)),
      title: str(),
      notes: str(MAX_TEXT),
      status: oneOf('todo', 'doing', 'done', 'blocked'),
      dueAt: orNull(num),
      owner: oneOf('user', 'agent'),
      blocker: str(),
      updatedAt: num,
    },
    runtime: ['createdAt'],
    remove: true,
  },
  goal: {
    fields: { id: str(128), title: str(), why: str(MAX_TEXT), status: oneOf('open', 'achieved', 'dropped') },
    runtime: ['createdAt'],
    remove: true,
  },
  memory: {
    fields: {
      id: str(128),
      title: str(),
      body: str(MAX_TEXT),
      kind: oneOf(...MEMORY_KINDS),
      topics: str(),
      pinned: bool,
      source: oneOf('agent', 'user'),
      updatedAt: num,
      status: oneOf('open', 'closed'),
      closedAt: orNull(num),
      aliases: str(),
      project: str(128),
    },
    runtime: ['createdAt'],
    remove: true,
  },
  // A routine: its user fields only. Its run state (last run, last result, its desk, a meeting it belongs to) and the
  // app's own routines (builtin) are the app's to move.
  trigger: {
    fields: {
      id: str(128),
      name: str(),
      kind: oneOf('at', 'daily', 'interval', 'event'),
      spec: str(),
      gatherSeconds: num,
      profile: str(128),
      prompt: str(MAX_TEXT),
      enabled: bool,
      catchUp: bool,
      deltaCheck: bool,
      device: str(128),
    },
    runtime: ['createdAt', 'lastRunAt', 'lastResult', 'lastStartedAt', 'deskId', 'eventId', 'movedEarly', 'builtin'],
    remove: true,
  },
  project: {
    fields: {
      id: str(128),
      name: str(),
      description: str(MAX_TEXT),
      aliases: listOf(str(), 100),
      icon: shape({ glyph: str(64), color: str(32), image: str(300_000) }),
      path: str(1_000),
      profile: str(128),
      hidden: bool,
      railAt: orNull(num),
      chats: listOf(str(128), 2_000),
      ai: picks,
      panelHidden: record(num, 2_000),
    },
    runtime: ['createdAt'],
    remove: true,
  },
  // A standing instruction: edited and switched off, never deleted (its history stays).
  prompt_rule: {
    fields: {
      id: str(128),
      text: str(MAX_TEXT),
      reason: str(),
      status: oneOf('active', 'removed'),
      updatedAt: num,
      history: listOf(
        shape({ n: num, at: num, by: str(), reason: str(), change: oneOf('added', 'edited', 'removed', 'restored'), text: str(MAX_TEXT) }),
        500,
      ),
    },
    runtime: ['createdAt'],
    remove: false,
  },
}

/** Check one generic write from another device. Returns the row to save (runtime fields dropped), or throws. */
export function checkRemoteUpsert(rawEntity: unknown, rawRow: unknown): { entity: string; row: Record<string, unknown> } {
  const entity = typeof rawEntity === 'string' ? rawEntity : ''
  const policy = Object.prototype.hasOwnProperty.call(WRITABLE, entity) ? WRITABLE[entity] : undefined
  if (policy === undefined) throw new Error(NOT_ALLOWED)
  if (!isObject(rawRow)) throw new Error('row must be an object')
  const row: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rawRow)) {
    if (policy.runtime?.includes(key) === true) continue
    const check = Object.prototype.hasOwnProperty.call(policy.fields, key) ? policy.fields[key] : undefined
    if (check === undefined) throw new Error(`${entity}.${key} cannot be set from another device`)
    if (!check(value)) throw new Error(`${entity}.${key} is not a valid value`)
    row[key] = value
  }
  const id = row['id']
  if (id !== undefined && (typeof id !== 'string' || !ID_PATTERN.test(id))) throw new Error(`${entity}.id is not a valid id`)
  return { entity, row }
}

/** Check one generic delete from another device. */
export function checkRemoteRemove(rawEntity: unknown, rawId: unknown): void {
  const entity = typeof rawEntity === 'string' ? rawEntity : ''
  const policy = Object.prototype.hasOwnProperty.call(WRITABLE, entity) ? WRITABLE[entity] : undefined
  if (policy === undefined || !policy.remove) throw new Error(NOT_ALLOWED)
  if (typeof rawId !== 'string' || !ID_PATTERN.test(rawId)) throw new Error('id is not valid')
}

/** What a device that is only `hands` (and any other device) may call without acting for the person. */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  'settings.get',
  'settings.providers',
  'settings.accounts.chatBrain',
  'settings.accounts.status',
  'account.status',
  'data.list',
  'data.where',
  'data.since',
  'data.page',
  'data.get',
  'device.prefs',
  'chat.mentions',
  'chat.state',
  'chat.states',
  'browser.state',
  'browser.people',
  'helpers.cards',
  'apps.status',
  'apps.catalog',
  'apps.search',
  'apps.learned',
  'profiles.list',
  'system.info',
  'app.info',
  'memory.searchChats',
  'memory.tidyState',
  'memory.history',
  'devices.status',
  'devices.list',
  'vault.list',
  'vault.prefs',
])

/** Does a device with these roles may call this allowlisted method? Acting for the person needs `screen` or `brain`. */
export function roleMayCall(roles: readonly DeviceRole[] | null | undefined, method: string): boolean {
  if (roles === null || roles === undefined) return false
  if (READ_ONLY_METHODS.has(method)) return roles.length > 0
  return roles.includes('screen') || roles.includes('brain')
}

/**
 * The whole gate for a generic data call from another device: refuses what it must, and returns the arguments to run
 * (a write's row cleaned). Other methods pass through unchanged.
 */
export function guardRemoteCall(method: string, args: unknown[], roles: readonly DeviceRole[] | null | undefined): unknown[] {
  if (!roleMayCall(roles, method)) throw new Error(NOT_ALLOWED)
  if (method === 'data.upsert') {
    const { entity, row } = checkRemoteUpsert(args[0], args[1])
    return [entity, row, ...args.slice(2)]
  }
  if (method === 'data.remove') {
    checkRemoteRemove(args[0], args[1])
    return args
  }
  return args
}
