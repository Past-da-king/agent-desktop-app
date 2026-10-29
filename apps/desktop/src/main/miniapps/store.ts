/**
 * Mini-apps as data (docs/plans/mini-apps.md): create, change, undo, pin and delete, over the synced `miniapp` rows.
 * Every save goes through the lint (shared/miniapps.ts) first and is refused on any finding; every change keeps the
 * version it replaced, so "undo the last change" works. Pins live on the rows, so every device shows the same order.
 *
 * Used by the agent tools (tools/miniapps.ts), the window (ipc.ts) and the bridge (host.ts, the app's own store).
 */
import type { MiniAppCheck, MiniAppRow } from '@agent/core'

import type { DataStore } from '../runtime/data'
import {
  applyPatches,
  lintMiniApp,
  lintReport,
  MINIAPP_STORE_MAX_BYTES,
  MINIAPP_STORE_MAX_KEYS,
  newMiniAppId,
  pinnedApps,
  pushHistory,
  repin,
  versionOf,
  type MiniAppDraft,
} from '../../shared/miniapps'

export type Result<T> = { ok: true; app: T; note?: string } | { ok: false; why: string }

export interface MiniAppChange {
  name?: string
  description?: string
  icon?: string
  /** Whole files: each given file is replaced (or added). A file set to '' is removed. */
  files?: Record<string, string>
  /** Exact-text edits inside files. */
  patches?: Array<{ file: string; old: string; new: string }>
  permissions?: string[]
  subscribe?: string[]
  refreshMinutes?: number
}

export interface MiniAppStoreDeps {
  store: DataStore
  now?: () => number
  /** Every tool name there is, so a permission for a tool that does not exist is caught. */
  knownTools?: () => ReadonlySet<string>
}

function draftOf(app: Pick<MiniAppRow, keyof MiniAppDraft>): MiniAppDraft {
  return {
    name: app.name,
    description: app.description,
    icon: app.icon,
    files: app.files,
    permissions: app.permissions,
    subscribe: app.subscribe,
    refreshMinutes: app.refreshMinutes,
  }
}

function uniq(list: string[]): string[] {
  return [...new Set(list.map((item) => item.trim()).filter(Boolean))]
}

export class MiniAppStore {
  private readonly store: DataStore
  private readonly now: () => number
  private readonly knownTools: (() => ReadonlySet<string>) | undefined

  constructor(deps: MiniAppStoreDeps) {
    this.store = deps.store
    this.now = deps.now ?? Date.now
    this.knownTools = deps.knownTools
  }

  async list(): Promise<MiniAppRow[]> {
    return (await this.store.list('miniapp')).sort((a, b) => a.name.localeCompare(b.name))
  }

  /** By id, or by name (any case), or by the start of an id. */
  async find(ref: string): Promise<MiniAppRow | null> {
    const key = ref.trim()
    if (key === '') return null
    const byId = await this.store.get('miniapp', key)
    if (byId !== null) return byId
    const all = await this.store.list('miniapp')
    const lower = key.toLowerCase()
    return all.find((app) => app.name.trim().toLowerCase() === lower) ?? all.find((app) => app.id.startsWith(key)) ?? null
  }

  private lint(draft: MiniAppDraft): string | null {
    const findings = lintMiniApp(draft, this.knownTools?.())
    return findings.length === 0 ? null : `Not saved. Fix these and save again:\n${lintReport(findings)}`
  }

  async create(input: MiniAppChange & { name: string }, who: { by: string; profile: string }): Promise<Result<MiniAppRow>> {
    const draft: MiniAppDraft = {
      name: input.name.trim(),
      description: (input.description ?? '').trim(),
      icon: (input.icon ?? 'apps').trim(),
      files: Object.fromEntries(Object.entries(input.files ?? {}).filter(([, text]) => text !== '')),
      permissions: uniq(input.permissions ?? []),
      subscribe: uniq(input.subscribe ?? []),
      refreshMinutes: input.refreshMinutes ?? 0,
    }
    const same = (await this.store.list('miniapp')).find((app) => app.name.trim().toLowerCase() === draft.name.toLowerCase())
    if (same !== undefined) return { ok: false, why: `There is already an app called "${same.name}" (${same.id}). Change that one with miniapp_update, or pick another name.` }
    const why = this.lint(draft)
    if (why !== null) return { ok: false, why }
    const now = this.now()
    const app = await this.store.upsert('miniapp', {
      id: newMiniAppId(),
      ...draft,
      profile: who.profile,
      version: 1,
      history: [],
      pinned: 0,
      allowed: [],
      data: {},
      check: { version: 0, at: 0, ok: false, issues: [], shots: [] },
      by: who.by,
      openedAt: 0,
      updatedAt: now,
    })
    return { ok: true, app }
  }

  async update(ref: string, change: MiniAppChange, who: { by: string; reason: string }): Promise<Result<MiniAppRow>> {
    const app = await this.find(ref)
    if (app === null) return { ok: false, why: `No app "${ref}". miniapp_list shows them.` }
    let files = { ...app.files }
    for (const [name, text] of Object.entries(change.files ?? {})) {
      if (text === '') delete files[name]
      else files[name] = text
    }
    if (change.patches !== undefined && change.patches.length > 0) {
      const patched = applyPatches(files, change.patches)
      if (!patched.ok) return { ok: false, why: `Not saved: ${patched.why}.` }
      files = patched.files
    }
    const draft: MiniAppDraft = {
      name: (change.name ?? app.name).trim(),
      description: (change.description ?? app.description).trim(),
      icon: (change.icon ?? app.icon).trim(),
      files,
      permissions: uniq(change.permissions ?? app.permissions),
      subscribe: uniq(change.subscribe ?? app.subscribe),
      refreshMinutes: change.refreshMinutes ?? app.refreshMinutes,
    }
    if (draft.name.toLowerCase() !== app.name.trim().toLowerCase()) {
      const clash = (await this.store.list('miniapp')).find((other) => other.id !== app.id && other.name.trim().toLowerCase() === draft.name.toLowerCase())
      if (clash !== undefined) return { ok: false, why: `There is already an app called "${clash.name}".` }
    }
    const why = this.lint(draft)
    if (why !== null) return { ok: false, why }
    const unchanged = JSON.stringify(draftOf(app)) === JSON.stringify(draft)
    if (unchanged) return { ok: true, app, note: 'Nothing changed.' }
    const now = this.now()
    // A permission it no longer has cannot stay allowed without asking.
    const allowed = app.allowed.filter((key) => draft.permissions.includes(key) || draft.permissions.includes(key.replace(/:.*$/, ':*')) || draft.permissions.includes(key.replace(/\/[^/]*$/, '/*')))
    const next = await this.store.upsert('miniapp', {
      ...app,
      ...draft,
      allowed,
      version: app.version + 1,
      history: pushHistory(app.history, versionOf(app, who.by, who.reason, now)),
      updatedAt: now,
    })
    return { ok: true, app: next }
  }

  /** Back to the version before (or version n): a new version, so the undo can itself be undone. */
  async undo(ref: string, who: { by: string }, n?: number): Promise<Result<MiniAppRow>> {
    const app = await this.find(ref)
    if (app === null) return { ok: false, why: `No app "${ref}".` }
    const target = n === undefined ? app.history[app.history.length - 1] : app.history.find((version) => version.n === n)
    if (target === undefined) return { ok: false, why: n === undefined ? 'There is no earlier version to go back to.' : `There is no kept version ${n} (kept: ${app.history.map((v) => v.n).join(', ') || 'none'}).` }
    const draft: MiniAppDraft = {
      name: target.name,
      description: target.description,
      icon: target.icon,
      files: target.files,
      permissions: target.permissions,
      subscribe: target.subscribe,
      refreshMinutes: target.refreshMinutes,
    }
    const why = this.lint(draft)
    if (why !== null) return { ok: false, why: `Version ${target.n} no longer passes the checks:\n${why}` }
    const now = this.now()
    const history = pushHistory(app.history.filter((version) => version !== target), versionOf(app, who.by, `went back to version ${target.n}`, now))
    const next = await this.store.upsert('miniapp', { ...app, ...draft, version: app.version + 1, history, updatedAt: now })
    return { ok: true, app: next, note: `Back to what version ${target.n} was (now version ${next.version}).` }
  }

  async remove(ref: string): Promise<Result<MiniAppRow>> {
    const app = await this.find(ref)
    if (app === null) return { ok: false, why: `No app "${ref}".` }
    await this.store.remove('miniapp', app.id)
    return { ok: true, app }
  }

  /** Pins it (at position, 1 = first; absent = last) or moves it; renumbers the others. */
  async pin(ref: string, position?: number): Promise<Result<MiniAppRow>> {
    const app = await this.find(ref)
    if (app === null) return { ok: false, why: `No app "${ref}".` }
    const all = await this.store.list('miniapp')
    const order = pinnedApps(all)
    const at = position === undefined ? (app.pinned > 0 ? order.findIndex((other) => other.id === app.id) + 1 : order.length + 1) : position
    await this.applyPins(all, repin(all, app.id, at))
    return { ok: true, app: (await this.store.get('miniapp', app.id)) ?? app }
  }

  async unpin(ref: string): Promise<Result<MiniAppRow>> {
    const app = await this.find(ref)
    if (app === null) return { ok: false, why: `No app "${ref}".` }
    const all = await this.store.list('miniapp')
    await this.applyPins(all, repin(all, app.id, null))
    return { ok: true, app: (await this.store.get('miniapp', app.id)) ?? app }
  }

  /** The whole sidebar order at once (a drag in the window). Ids not given are unpinned. */
  async setOrder(ids: string[]): Promise<void> {
    const all = await this.store.list('miniapp')
    const target = new Map(ids.map((id, index) => [id, index + 1]))
    const changes = all.filter((app) => (target.get(app.id) ?? 0) !== app.pinned).map((app) => ({ id: app.id, pinned: target.get(app.id) ?? 0 }))
    await this.applyPins(all, changes)
  }

  private async applyPins(all: MiniAppRow[], changes: Array<{ id: string; pinned: number }>): Promise<void> {
    for (const change of changes) {
      const row = all.find((app) => app.id === change.id)
      if (row !== undefined) await this.store.upsert('miniapp', { ...row, pinned: change.pinned })
    }
  }

  /** He lets the app run one tool that changes something without asking (or takes that back). Window only. */
  async setAllowed(id: string, key: string, on: boolean): Promise<void> {
    const app = await this.store.get('miniapp', id)
    if (app === null) return
    const allowed = on ? uniq([...app.allowed, key]) : app.allowed.filter((other) => other !== key)
    await this.store.upsert('miniapp', { ...app, allowed })
  }

  async setCheck(id: string, check: MiniAppCheck): Promise<void> {
    const app = await this.store.get('miniapp', id)
    if (app !== null) await this.store.upsert('miniapp', { ...app, check })
  }

  async opened(id: string): Promise<void> {
    const app = await this.store.get('miniapp', id)
    if (app !== null) await this.store.upsert('miniapp', { ...app, openedAt: this.now() })
  }

  // ---- the app's own store (agent.store) -------------------------------------------------------------------

  async dataGet(id: string, key: string): Promise<string | null> {
    return (await this.store.get('miniapp', id))?.data[key] ?? null
  }

  async dataKeys(id: string): Promise<string[]> {
    return Object.keys((await this.store.get('miniapp', id))?.data ?? {})
  }

  async dataSet(id: string, key: string, value: string | null): Promise<{ ok: boolean; why?: string }> {
    const app = await this.store.get('miniapp', id)
    if (app === null) return { ok: false, why: 'The app is gone.' }
    if (key === '' || key.length > 100) return { ok: false, why: 'A key is 1 to 100 characters.' }
    const data = { ...app.data }
    if (value === null) delete data[key]
    else data[key] = value
    if (Object.keys(data).length > MINIAPP_STORE_MAX_KEYS) return { ok: false, why: `An app keeps at most ${MINIAPP_STORE_MAX_KEYS} keys.` }
    if (JSON.stringify(data).length > MINIAPP_STORE_MAX_BYTES) return { ok: false, why: `An app keeps at most ${MINIAPP_STORE_MAX_BYTES} characters.` }
    await this.store.upsert('miniapp', { ...app, data })
    return { ok: true }
  }
}
