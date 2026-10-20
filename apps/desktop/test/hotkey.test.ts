import { describe, expect, it, vi } from 'vitest'

import { HotkeyBinder, formatAccelerator, type ShortcutRegistry } from '../src/main/hotkey'

interface FakeRegistry extends ShortcutRegistry {
  take: Set<string>
  calls: string[]
  handlers: Map<string, () => void>
}

function registry(taken: string[] = []): FakeRegistry {
  const fake: FakeRegistry = {
    take: new Set(taken),
    calls: [],
    handlers: new Map(),
    register(accelerator, callback) {
      fake.calls.push(`register:${accelerator}`)
      if (fake.take.has(accelerator)) return false
      fake.take.add(accelerator)
      fake.handlers.set(accelerator, callback)
      return true
    },
    unregister(accelerator) {
      fake.calls.push(`unregister:${accelerator}`)
      fake.take.delete(accelerator)
      fake.handlers.delete(accelerator)
    },
  }
  return fake
}

describe('HotkeyBinder', () => {
  it('registers the setting and fires the trigger', () => {
    const shortcuts = registry()
    const trigger = vi.fn()
    const binder = new HotkeyBinder(shortcuts, trigger)

    expect(binder.apply('CommandOrControl+Shift+Space')).toMatchObject({ ok: true })
    expect(binder.currentAccelerator()).toBe('CommandOrControl+Shift+Space')

    shortcuts.handlers.get('CommandOrControl+Shift+Space')?.()
    expect(trigger).toHaveBeenCalledOnce()
  })

  it('unregisters the old shortcut before registering the new one', () => {
    const shortcuts = registry()
    const binder = new HotkeyBinder(shortcuts, () => undefined)
    binder.apply('CommandOrControl+Shift+Space')
    binder.apply('CommandOrControl+Alt+A')

    expect(shortcuts.calls).toEqual([
      'register:CommandOrControl+Shift+Space',
      'unregister:CommandOrControl+Shift+Space',
      'register:CommandOrControl+Alt+A',
    ])
    expect(shortcuts.take.has('CommandOrControl+Shift+Space')).toBe(false)
  })

  it('reports a taken shortcut and keeps nothing registered', () => {
    const shortcuts = registry(['CommandOrControl+Shift+Space'])
    const statuses: Array<{ ok: boolean; message: string }> = []
    const binder = new HotkeyBinder(shortcuts, () => undefined, (status) => statuses.push(status))

    const result = binder.apply('CommandOrControl+Shift+Space')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('could not be registered')
    expect(binder.currentAccelerator()).toBeNull()
    expect(statuses).toHaveLength(1)
  })

  it('treats an empty setting as no shortcut and releases the old one', () => {
    const shortcuts = registry()
    const binder = new HotkeyBinder(shortcuts, () => undefined)
    binder.apply('CommandOrControl+Shift+Space')
    const result = binder.apply('   ')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('no shortcut')
    expect(shortcuts.take.size).toBe(0)
  })

  it('dispose releases the registered accelerator', () => {
    const shortcuts = registry()
    const binder = new HotkeyBinder(shortcuts, () => undefined)
    binder.apply('CommandOrControl+Shift+Space')
    binder.dispose()
    expect(shortcuts.take.size).toBe(0)
    expect(binder.currentAccelerator()).toBeNull()
  })
})

describe('formatAccelerator', () => {
  it('writes the modifiers the way each platform names them', () => {
    expect(formatAccelerator('CommandOrControl+Shift+Space', 'win32')).toBe('Ctrl+Shift+Space')
    expect(formatAccelerator('CommandOrControl+Shift+Space', 'darwin')).toBe('Cmd+Shift+Space')
    expect(formatAccelerator('Control+Alt+K', 'linux')).toBe('Ctrl+Alt+K')
    expect(formatAccelerator('Command+Option+Enter', 'darwin')).toBe('Cmd+Option+Enter')
  })
})
