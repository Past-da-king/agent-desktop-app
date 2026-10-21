import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS, type HotkeyStatus } from '@agent/core'

import type { ShortcutRegistry } from '../src/main/hotkey'
import { HotkeyManager, canonicalAccelerator, cleanSwitchAccelerator, upgradeHotkeys } from '../src/main/hotkeys'
import { cachedLister, likelyHolder, parseTasklist } from '../src/main/hotkey-holders'
import { SettingsStore } from '../src/main/settings'
import { cleanSwitchKeys } from '../src/renderer/lib/hotkey'

interface FakeRegistry extends ShortcutRegistry {
  taken: Set<string>
  calls: string[]
  handlers: Map<string, () => void>
  press(accelerator: string): void
}

/** Like Electron's globalShortcut: another app's shortcut cannot be taken; ours are kept by accelerator. */
function registry(otherApps: string[] = []): FakeRegistry {
  const fake: FakeRegistry = {
    taken: new Set(otherApps),
    calls: [],
    handlers: new Map(),
    register(accelerator, callback) {
      fake.calls.push(`register:${accelerator}`)
      if (fake.taken.has(accelerator) || fake.handlers.has(accelerator)) return false
      fake.handlers.set(accelerator, callback)
      return true
    },
    unregister(accelerator) {
      fake.calls.push(`unregister:${accelerator}`)
      fake.handlers.delete(accelerator)
    },
    press(accelerator) {
      fake.handlers.get(accelerator)?.()
    },
  }
  return fake
}

const DEFAULTS = { quickAsk: 'CommandOrControl+Alt+Left', dictate: 'Alt+Space', dictateClean: 'CommandOrControl+Alt+C' }

function manager(shortcuts: FakeRegistry, onStatus?: (statuses: HotkeyStatus[]) => void) {
  const fired: string[] = []
  const hotkeys = new HotkeyManager(
    shortcuts,
    {
      quickAsk: () => fired.push('quickAsk'),
      dictate: () => fired.push('dictate'),
      dictateClean: () => fired.push('dictateClean'),
    },
    onStatus,
    'win32',
  )
  return { hotkeys, fired }
}

describe('the default shortcuts', () => {
  it('are Ctrl+Alt+Left for quick chat, Alt+Space to dictate and Ctrl+Alt+C to dictate and clean up', () => {
    expect(DEFAULT_SETTINGS.quickAskHotkey).toBe('CommandOrControl+Alt+Left')
    expect(DEFAULT_SETTINGS.dictateHotkey).toBe('Alt+Space')
    expect(DEFAULT_SETTINGS.dictateCleanHotkey).toBe('CommandOrControl+Alt+C')
  })
})

describe('HotkeyManager', () => {
  it('registers all three and fires the right action', () => {
    const shortcuts = registry()
    const statuses: HotkeyStatus[][] = []
    const { hotkeys, fired } = manager(shortcuts, (list) => statuses.push(list))
    const result = hotkeys.apply(DEFAULTS)

    expect(result.map((status) => [status.action, status.ok])).toEqual([
      ['quickAsk', true],
      ['dictate', true],
      ['dictateClean', true],
    ])
    expect(result[1]?.message).toBe('Ready on Alt+Space.')
    expect(result[0]?.message).toBe('Ready on Ctrl+Alt+Left.')
    expect(statuses).toHaveLength(1)

    shortcuts.press('Alt+Space')
    shortcuts.press('CommandOrControl+Alt+C')
    shortcuts.press('CommandOrControl+Alt+Left')
    expect(fired).toEqual(['dictate', 'dictateClean', 'quickAsk'])
  })

  it('rebinding moves only to the new keys, and the old ones are let go', () => {
    const shortcuts = registry()
    const { hotkeys, fired } = manager(shortcuts)
    hotkeys.apply(DEFAULTS)
    shortcuts.calls.length = 0
    hotkeys.apply({ ...DEFAULTS, dictate: 'CommandOrControl+Shift+D' })

    expect(shortcuts.handlers.has('Alt+Space')).toBe(false)
    expect(shortcuts.handlers.has('CommandOrControl+Shift+D')).toBe(true)
    shortcuts.press('CommandOrControl+Shift+D')
    expect(fired).toEqual(['dictate'])
    expect(hotkeys.bindings().dictate).toBe('CommandOrControl+Shift+D')
  })

  it('does nothing when the settings did not change', () => {
    const shortcuts = registry()
    const { hotkeys } = manager(shortcuts)
    hotkeys.apply(DEFAULTS)
    shortcuts.calls.length = 0
    hotkeys.apply({ ...DEFAULTS })
    expect(shortcuts.calls).toEqual([])
  })

  it('reports a shortcut another app holds, and keeps the others working', () => {
    const shortcuts = registry(['Alt+Space'])
    const { hotkeys } = manager(shortcuts)
    const [quick, dictate, clean] = hotkeys.apply(DEFAULTS)

    expect(quick?.ok).toBe(true)
    expect(dictate?.ok).toBe(false)
    expect(dictate?.message).toBe('Alt+Space could not be registered. Another app may already use it. Pick another, or close that app, and this starts working by itself.')
    expect(clean?.ok).toBe(true)
  })

  it('catches two of our own shortcuts on the same keys, however they are spelled', () => {
    const shortcuts = registry()
    const { hotkeys } = manager(shortcuts)
    const [, , clean] = hotkeys.apply({ ...DEFAULTS, dictateClean: 'Control+Alt+Left' })

    expect(clean?.ok).toBe(false)
    expect(clean?.message).toBe('Ctrl+Alt+Left is already your Quick chat shortcut. Pick another.')
    // The clash was caught before asking the OS.
    expect(shortcuts.calls.filter((call) => call === 'register:Control+Alt+Left')).toEqual([])
  })

  it('treats an empty setting as off', () => {
    const shortcuts = registry()
    const { hotkeys } = manager(shortcuts)
    const [, dictate] = hotkeys.apply({ ...DEFAULTS, dictate: '  ' })
    expect(dictate).toMatchObject({ ok: false, accelerator: '', message: 'Dictation has no shortcut. Record one to use it.' })
  })

  it('steps aside while Settings records a shortcut, then comes back', () => {
    const shortcuts = registry()
    const { hotkeys, fired } = manager(shortcuts)
    hotkeys.apply(DEFAULTS)
    hotkeys.pause(true)
    expect(shortcuts.handlers.size).toBe(0)
    // A change made while paused is applied on resume.
    hotkeys.apply({ ...DEFAULTS, quickAsk: 'CommandOrControl+Alt+Q' })
    expect(shortcuts.handlers.size).toBe(0)
    hotkeys.pause(false)
    expect([...shortcuts.handlers.keys()].sort()).toEqual(['Alt+Space', 'CommandOrControl+Alt+C', 'CommandOrControl+Alt+Q'])
    shortcuts.press('CommandOrControl+Alt+Q')
    expect(fired).toEqual(['quickAsk'])
  })

  it('holds a shortcut for a moment and lets it go', () => {
    const shortcuts = registry()
    const { hotkeys } = manager(shortcuts)
    hotkeys.apply(DEFAULTS)
    const pressed = vi.fn()
    const release = hotkeys.hold('Alt+C', pressed)
    expect(release).not.toBeNull()
    shortcuts.press('Alt+C')
    expect(pressed).toHaveBeenCalledOnce()
    release?.()
    expect(shortcuts.handlers.has('Alt+C')).toBe(false)

    // Not one of our own shortcuts, not one another app holds, not while paused.
    expect(hotkeys.hold('Control+Alt+C', () => undefined)).toBeNull()
    expect(manager(registry(['Alt+C'])).hotkeys.hold('Alt+C', () => undefined)).toBeNull()
    hotkeys.pause(true)
    expect(hotkeys.hold('Escape', () => undefined)).toBeNull()
  })
})

describe('a shortcut another app holds', () => {
  it('starts working by itself once that app lets go, and Settings hears it', () => {
    const shortcuts = registry(['Alt+Space'])
    const statuses: HotkeyStatus[][] = []
    const { hotkeys, fired } = manager(shortcuts, (list) => statuses.push(list))
    hotkeys.apply(DEFAULTS)
    expect(hotkeys.blocked()).toEqual([{ action: 'dictate', accelerator: 'Alt+Space' }])

    // Still held: nothing changes and nothing is reported.
    expect(hotkeys.retry()).toEqual([])
    expect(statuses).toHaveLength(1)

    // Wispr Flow quits.
    shortcuts.taken.delete('Alt+Space')
    expect(hotkeys.retry()).toEqual(['dictate'])
    expect(statuses).toHaveLength(2)
    expect(statuses[1]?.find((status) => status.action === 'dictate')).toMatchObject({ ok: true, message: 'Ready on Alt+Space.' })
    expect(hotkeys.blocked()).toEqual([])
    shortcuts.press('Alt+Space')
    expect(fired).toEqual(['dictate'])
    // The other two were never touched again.
    expect(shortcuts.calls.filter((call) => call.startsWith('register:CommandOrControl'))).toHaveLength(2)
  })

  it('does not retry a clash between our own shortcuts, an empty one, or while paused', () => {
    const shortcuts = registry(['Alt+Space'])
    const { hotkeys } = manager(shortcuts)
    hotkeys.apply({ ...DEFAULTS, dictateClean: 'Control+Alt+Left', quickAsk: '' })
    expect(hotkeys.blocked().map((item) => item.action)).toEqual(['dictate'])
    hotkeys.pause(true)
    shortcuts.taken.delete('Alt+Space')
    expect(hotkeys.retry()).toEqual([])
    hotkeys.pause(false)
    expect(hotkeys.blocked()).toEqual([])
  })

  it('names the app that probably holds it, once, and only while it is blocked', () => {
    const shortcuts = registry(['Alt+Space'])
    const statuses: HotkeyStatus[][] = []
    const { hotkeys } = manager(shortcuts, (list) => statuses.push(list))
    hotkeys.apply(DEFAULTS)
    hotkeys.explain('dictate', 'Wispr Flow')
    expect(hotkeys.status()[1]?.message).toBe('Alt+Space is being used by Wispr Flow. Quit Wispr Flow or change its shortcut, and this starts working by itself.')
    expect(statuses).toHaveLength(2)
    hotkeys.explain('dictate', 'Wispr Flow')
    expect(statuses).toHaveLength(2)
    hotkeys.explain('quickAsk', 'Wispr Flow')
    expect(hotkeys.status()[0]?.message).toBe('Ready on Ctrl+Alt+Left.')
    hotkeys.explain('dictate', null)
    expect(hotkeys.status()[1]?.message).toContain('could not be registered')
  })
})

describe('the clean-up switch', () => {
  it('is the dictation shortcut with C in place of its key', () => {
    expect(cleanSwitchAccelerator('Alt+Space')).toBe('Alt+C')
    expect(cleanSwitchAccelerator('CommandOrControl+Shift+D')).toBe('CommandOrControl+Shift+C')
    expect(cleanSwitchAccelerator('F9')).toBeNull()
    expect(cleanSwitchAccelerator('Alt+C')).toBeNull()
    expect(cleanSwitchKeys('Alt+Space', 'win32')).toBe('Alt+C')
    expect(cleanSwitchKeys('F9', 'win32')).toBe('')
  })

  it('spells the same keys the same way', () => {
    expect(canonicalAccelerator('CmdOrCtrl+alt+left', 'win32')).toBe('Ctrl+Alt+Left')
    expect(canonicalAccelerator('Alt+Control+Left', 'win32')).toBe('Ctrl+Alt+Left')
    expect(canonicalAccelerator('CommandOrControl+Alt+C', 'darwin')).toBe('Cmd+Alt+C')
  })
})

describe('moving to the new defaults', () => {
  let dir = ''
  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('gives a settings file from before dictation the new quick chat default, and leaves a chosen one alone', () => {
    expect(upgradeHotkeys({ quickAskHotkey: 'CommandOrControl+Shift+Space' })).toEqual({})
    expect(upgradeHotkeys({ quickAskHotkey: 'CommandOrControl+Alt+Q' })).toEqual({ quickAskHotkey: 'CommandOrControl+Alt+Q' })
    expect(upgradeHotkeys({ quickAskHotkey: 'CommandOrControl+Shift+Space', dictateHotkey: 'Alt+Space' })).toMatchObject({
      quickAskHotkey: 'CommandOrControl+Shift+Space',
    })
    expect(upgradeHotkeys(null)).toBeNull()

    dir = mkdtempSync(join(tmpdir(), 'agent-hotkeys-'))
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ quickAskHotkey: 'CommandOrControl+Shift+Space', userName: 'Ayanda', deviceName: 'pc' }))
    const store = new SettingsStore(file, { hostname: () => 'pc' })
    expect(store.get()).toMatchObject({ quickAskHotkey: 'CommandOrControl+Alt+Left', dictateHotkey: 'Alt+Space', userName: 'Ayanda' })
    store.save({ dictateHotkey: 'CommandOrControl+Shift+D' })
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(saved['quickAskHotkey']).toBe('CommandOrControl+Alt+Left')

    // Choosing the old keys on purpose sticks.
    store.save({ quickAskHotkey: 'CommandOrControl+Shift+Space' })
    expect(new SettingsStore(file, { hostname: () => 'pc' }).get().quickAskHotkey).toBe('CommandOrControl+Shift+Space')
  })
})

describe('guessing who holds a shortcut', () => {
  // The first lines of `tasklist /fo csv /nh` on Ayanda's PC, 21 Oct 2026.
  const TASKLIST = ['"System Idle Process","0","Services","0","8 K"', '"Wispr Flow.exe","1828","Console","1","214,284 K"', '"Wispr Flow Helper.exe","19120","Console","1","53,328 K"', ''].join('\r\n')

  it('reads process names from tasklist', () => {
    expect(parseTasklist(TASKLIST)).toEqual(new Set(['system idle process', 'wispr flow.exe', 'wispr flow helper.exe']))
  })

  it('names Wispr Flow whenever it runs, else an app that takes the shortcut out of the box', () => {
    expect(likelyHolder('Alt+Space', parseTasklist(TASKLIST))).toBe('Wispr Flow')
    expect(likelyHolder('Alt+Space', new Set(['powertoys.powerlauncher.exe', 'chatgpt.exe']))).toBe('PowerToys Run')
    expect(likelyHolder('Alt+Space', new Set(['chatgpt.exe']))).toBe('ChatGPT')
    expect(likelyHolder('Alt+Space', new Set(['raycast.exe']))).toBe('Raycast')
    expect(likelyHolder('CommandOrControl+Alt+Left', new Set(['chatgpt.exe']))).toBeNull()
    expect(likelyHolder('Alt+Space', new Set(['notepad.exe']))).toBeNull()
  })

  it('asks for the process list at most once in a while', async () => {
    let calls = 0
    let now = 0
    const list = cachedLister(async () => {
      calls += 1
      return new Set(['wispr flow.exe'])
    }, 30_000, () => now)
    await list()
    now = 10_000
    await list()
    expect(calls).toBe(1)
    now = 40_001
    await list()
    expect(calls).toBe(2)
  })
})
