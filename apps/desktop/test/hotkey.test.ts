import { describe, expect, it, vi } from 'vitest'

import {
  HotkeyBinder,
  QUICK_ASK_HEIGHT,
  QUICK_ASK_PAD,
  QUICK_ASK_SNAP,
  QUICK_ASK_WIDTH,
  formatAccelerator,
  quickAskClamp,
  quickAskPositionToSpot,
  quickAskSnap,
  quickAskSpotToPosition,
  type ShortcutRegistry,
} from '../src/main/hotkey'

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

describe('quick ask orb: drag, snap, stay on screen, remember the spot', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 }
  const second = { x: 1920, y: 0, width: 1280, height: 680 }

  it('snaps to the left, right, top and bottom edges when it comes close', () => {
    expect(quickAskSnap({ x: -4, y: 300 }, area).x).toBe(12 - QUICK_ASK_PAD)
    expect(quickAskSnap({ x: 1920 - QUICK_ASK_WIDTH + 10, y: 300 }, area).x).toBe(1920 - 12 + QUICK_ASK_PAD - QUICK_ASK_WIDTH)
    expect(quickAskSnap({ x: 400, y: 5 }, area).y).toBe(12 - QUICK_ASK_PAD)
    expect(quickAskSnap({ x: 400, y: 1040 - QUICK_ASK_HEIGHT + 15 }, area).y).toBe(1040 - 12 + QUICK_ASK_PAD - QUICK_ASK_HEIGHT)
  })

  it('snaps to the centre lines, and leaves it alone elsewhere', () => {
    const cx = (1920 - QUICK_ASK_WIDTH) / 2
    expect(quickAskSnap({ x: cx + QUICK_ASK_SNAP - 1, y: 300 }, area).x).toBe(cx)
    expect(quickAskSnap({ x: 300, y: 300 }, area)).toEqual({ x: 300, y: 300 })
  })

  it('never lets the orb leave the screen, on any screen, even a small one', () => {
    expect(quickAskClamp({ x: -900, y: -900 }, area)).toEqual({ x: -QUICK_ASK_PAD, y: -QUICK_ASK_PAD })
    expect(quickAskClamp({ x: 9000, y: 9000 }, second)).toEqual({ x: 1920 + 1280 + QUICK_ASK_PAD - QUICK_ASK_WIDTH, y: 680 + QUICK_ASK_PAD - QUICK_ASK_HEIGHT })
    const tiny = { x: 0, y: 0, width: 500, height: 120 }
    const pos = quickAskClamp({ x: 200, y: 200 }, tiny)
    expect(pos.x).toBe(-QUICK_ASK_PAD)
    expect(pos.y).toBe(-QUICK_ASK_PAD)
  })

  it('keeps a spot as a share of the screen, so it lands in the same place after a scale change', () => {
    const spot = quickAskPositionToSpot({ x: 2100, y: 340 }, second)
    expect(quickAskSpotToPosition(spot, second)).toEqual({ x: 2100, y: 340 })
    const scaled = { x: 1920, y: 0, width: 1024, height: 544 }
    const moved = quickAskSpotToPosition(spot, scaled)
    expect(moved.x).toBe(Math.round(1920 + spot.fx * 1024))
    expect(moved.y).toBe(Math.round(0.5 * 544))
  })
})
