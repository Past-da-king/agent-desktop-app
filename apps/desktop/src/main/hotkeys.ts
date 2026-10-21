/**
 * Every global shortcut the app owns: Quick chat, Dictation and Dictate and clean up.
 *
 * One manager holds them so a clash between two of our own shortcuts is caught here (the OS would only say
 * "taken"), and so a shortcut can be held for a moment only (the clean-up switch and Esc while dictating).
 * It talks to an injected registry, so tests drive it with a fake.
 */
import type { HotkeyAction, HotkeyStatus } from '@agent/core'

import { formatAccelerator, type ShortcutRegistry } from './hotkey'

export const HOTKEY_ACTIONS: HotkeyAction[] = ['quickAsk', 'dictate', 'dictateClean']

export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  quickAsk: 'Quick chat',
  dictate: 'Dictation',
  dictateClean: 'Dictate and clean up',
}

export type HotkeyBindings = Record<HotkeyAction, string>

/** The Quick Ask default before dictation existed. A settings file that still has it gets the new default. */
export const OLD_QUICK_ASK_DEFAULT = 'CommandOrControl+Shift+Space'

const MODIFIER_ORDER = ['Ctrl', 'Cmd', 'Super', 'Alt', 'Shift']

/** One spelling per shortcut, so "CmdOrCtrl+alt+left" and "Control+Alt+Left" are seen as the same keys. */
export function canonicalAccelerator(accelerator: string, platform: NodeJS.Platform = process.platform): string {
  const parts = accelerator
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  const mods = new Set<string>()
  let key = ''
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'commandorcontrol' || lower === 'cmdorctrl') mods.add(platform === 'darwin' ? 'Cmd' : 'Ctrl')
    else if (lower === 'control' || lower === 'ctrl') mods.add('Ctrl')
    else if (lower === 'command' || lower === 'cmd') mods.add('Cmd')
    else if (lower === 'super' || lower === 'meta') mods.add('Super')
    else if (lower === 'alt' || lower === 'option' || lower === 'altgr') mods.add('Alt')
    else if (lower === 'shift') mods.add('Shift')
    else key = part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
  }
  return [...MODIFIER_ORDER.filter((mod) => mods.has(mod)), key].join('+')
}

/**
 * The clean-up switch while a dictation is running: the dictation shortcut's own modifiers with C.
 * Alt+Space gives Alt+C, so holding Alt and pressing Space then C starts a dictation that is cleaned up.
 * Null when the dictation shortcut has no modifier (a bare C would take the letter from every app).
 */
export function cleanSwitchAccelerator(dictate: string): string | null {
  const parts = dictate
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length < 2) return null
  const key = parts[parts.length - 1] ?? ''
  if (key.toUpperCase() === 'C') return null
  return [...parts.slice(0, -1), 'C'].join('+')
}

/** Settings files from before dictation kept the old Quick Ask default; they move to the new one. */
export function upgradeHotkeys(raw: Record<string, unknown> | null): Record<string, unknown> | null {
  if (raw === null || 'dictateHotkey' in raw) return raw
  if (raw['quickAskHotkey'] !== OLD_QUICK_ASK_DEFAULT) return raw
  const next = { ...raw }
  delete next['quickAskHotkey']
  return next
}

/** Why a shortcut is not live: another app holds it (worth retrying), two of ours clash, or it is off. */
type Failure = 'taken' | 'clash' | 'off'

export class HotkeyManager {
  private readonly live = new Map<HotkeyAction, string>()
  private readonly failures = new Map<HotkeyAction, Failure>()
  private readonly held = new Map<string, string>()
  private wanted: HotkeyBindings = { quickAsk: '', dictate: '', dictateClean: '' }
  private statuses: HotkeyStatus[] = []
  private paused = false

  constructor(
    private readonly registry: ShortcutRegistry,
    private readonly handlers: Record<HotkeyAction, () => void>,
    private readonly onStatus?: (statuses: HotkeyStatus[]) => void,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  status(): HotkeyStatus[] {
    return this.statuses.map((status) => ({ ...status }))
  }

  bindings(): HotkeyBindings {
    return { ...this.wanted }
  }

  /** The shortcuts another app is holding right now, to retry or to explain. */
  blocked(): Array<{ action: HotkeyAction; accelerator: string }> {
    return HOTKEY_ACTIONS.filter((action) => this.failures.get(action) === 'taken').map((action) => ({ action, accelerator: this.wanted[action] }))
  }

  /**
   * Tries again every shortcut another app was holding (that app may have quit since). Statuses are reported
   * only when one came free. Returns the actions that are live now.
   */
  retry(): HotkeyAction[] {
    if (this.paused) return []
    const freed: HotkeyAction[] = []
    for (const { action, accelerator } of this.blocked()) {
      let ok = false
      try {
        ok = this.registry.register(accelerator, () => this.handlers[action]())
      } catch {
        ok = false
      }
      if (!ok) continue
      this.live.set(action, accelerator)
      this.failures.delete(action)
      this.setStatus({ action, accelerator, ok: true, message: `Ready on ${formatAccelerator(accelerator, this.platform)}.` })
      freed.push(action)
    }
    if (freed.length > 0) this.onStatus?.(this.status())
    return freed
  }

  /** Names the app that is probably holding a blocked shortcut. Reported only when the words change. */
  explain(action: HotkeyAction, holder: string | null): void {
    if (this.failures.get(action) !== 'taken') return
    const accelerator = this.wanted[action]
    const message = holder === null ? takenMessage(accelerator, this.platform) : holderMessage(accelerator, holder, this.platform)
    const current = this.statuses.find((status) => status.action === action)
    if (current === undefined || current.message === message) return
    this.setStatus({ ...current, message })
    this.onStatus?.(this.status())
  }

  private setStatus(next: HotkeyStatus): void {
    this.statuses = this.statuses.map((status) => (status.action === next.action ? next : status))
  }

  /** Points every shortcut at its setting. Unchanged settings are not touched. */
  apply(bindings: HotkeyBindings): HotkeyStatus[] {
    const same = HOTKEY_ACTIONS.every((action) => bindings[action].trim() === this.wanted[action]) && this.statuses.length > 0
    if (same) return this.status()
    this.wanted = {
      quickAsk: bindings.quickAsk.trim(),
      dictate: bindings.dictate.trim(),
      dictateClean: bindings.dictateClean.trim(),
    }
    if (this.paused) return this.status()
    this.registerAll()
    return this.status()
  }

  /** While the Settings recorder listens, our shortcuts step aside so the key reaches it. */
  pause(paused: boolean): void {
    if (paused === this.paused) return
    this.paused = paused
    if (paused) {
      this.releaseAll()
      for (const accelerator of [...this.held.keys()]) this.release(accelerator)
    } else {
      this.registerAll()
    }
  }

  /**
   * Holds a shortcut for a moment (the clean-up switch, Esc while dictating). Returns how to let it go, or
   * null when it cannot be held: one of our own shortcuts already uses it, another app has it, or we are paused.
   */
  hold(accelerator: string, callback: () => void): (() => void) | null {
    if (this.paused || accelerator.trim() === '') return null
    const canonical = canonicalAccelerator(accelerator, this.platform)
    const ours = [...this.live.values()].some((value) => canonicalAccelerator(value, this.platform) === canonical)
    if (ours || [...this.held.values()].includes(canonical)) return null
    let ok = false
    try {
      ok = this.registry.register(accelerator, callback)
    } catch {
      ok = false
    }
    if (!ok) return null
    this.held.set(accelerator, canonical)
    return () => this.release(accelerator)
  }

  dispose(): void {
    this.releaseAll()
    for (const accelerator of [...this.held.keys()]) this.release(accelerator)
  }

  private release(accelerator: string): void {
    if (!this.held.has(accelerator)) return
    this.held.delete(accelerator)
    try {
      this.registry.unregister(accelerator)
    } catch {
      // Already gone.
    }
  }

  private releaseAll(): void {
    for (const accelerator of this.live.values()) {
      try {
        this.registry.unregister(accelerator)
      } catch {
        // A shortcut that is already gone cannot be unregistered; that is fine.
      }
    }
    this.live.clear()
  }

  private registerAll(): void {
    this.releaseAll()
    this.failures.clear()
    const taken = new Map<string, HotkeyAction>()
    const statuses: HotkeyStatus[] = []
    for (const action of HOTKEY_ACTIONS) {
      const accelerator = this.wanted[action]
      const label = HOTKEY_LABELS[action]
      if (accelerator === '') {
        this.failures.set(action, 'off')
        statuses.push({ action, accelerator, ok: false, message: `${label} has no shortcut. Record one to use it.` })
        continue
      }
      const keys = formatAccelerator(accelerator, this.platform)
      const canonical = canonicalAccelerator(accelerator, this.platform)
      const owner = taken.get(canonical)
      if (owner !== undefined) {
        this.failures.set(action, 'clash')
        statuses.push({
          action,
          accelerator,
          ok: false,
          message: `${keys} is already your ${HOTKEY_LABELS[owner]} shortcut. Pick another.`,
        })
        continue
      }
      let ok = false
      try {
        ok = this.registry.register(accelerator, () => this.handlers[action]())
      } catch {
        ok = false
      }
      if (ok) {
        this.live.set(action, accelerator)
        taken.set(canonical, action)
        statuses.push({ action, accelerator, ok: true, message: `Ready on ${keys}.` })
      } else {
        this.failures.set(action, 'taken')
        statuses.push({ action, accelerator, ok: false, message: takenMessage(accelerator, this.platform) })
      }
    }
    this.statuses = statuses
    this.onStatus?.(this.status())
  }
}

export function takenMessage(accelerator: string, platform: NodeJS.Platform = process.platform): string {
  const keys = formatAccelerator(accelerator, platform)
  return `${keys} could not be registered. Another app may already use it. Pick another, or close that app, and this starts working by itself.`
}

export function holderMessage(accelerator: string, holder: string, platform: NodeJS.Platform = process.platform): string {
  const keys = formatAccelerator(accelerator, platform)
  return `${keys} is being used by ${holder}. Quit ${holder} or change its shortcut, and this starts working by itself.`
}
