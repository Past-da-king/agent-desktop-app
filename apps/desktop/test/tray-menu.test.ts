import { describe, expect, it, vi } from 'vitest'

import { buildTrayMenu, type TrayMenuActions } from '../src/main/tray-menu'

function actions(): TrayMenuActions & Record<string, ReturnType<typeof vi.fn>> {
  return {
    open: vi.fn(),
    quickAsk: vi.fn(),
    showNeedsYou: vi.fn(),
    toggleRoutines: vi.fn(),
    quit: vi.fn(),
  }
}

const idle = { needsYou: 0, routinesPaused: false }

describe('buildTrayMenu', () => {
  it('shows the everyday items in a stable order', () => {
    const menu = buildTrayMenu(idle, actions())
    expect(menu.map((item) => item.label ?? item.type)).toEqual([
      'Open Agent',
      'Quick Ask',
      'separator',
      'Pause routines',
      'separator',
      'Quit',
    ])
  })

  it('adds "Needs you (n)" only when something is waiting', () => {
    const quiet = buildTrayMenu(idle, actions())
    expect(quiet.some((item) => item.label?.startsWith('Needs you'))).toBe(false)

    const waiting = buildTrayMenu({ needsYou: 2, routinesPaused: false }, actions())
    const item = waiting.find((entry) => entry.label === 'Needs you (2)')
    expect(item).toBeDefined()
    expect(waiting.map((entry) => entry.label).indexOf('Needs you (2)')).toBe(2)
  })

  it('wires every item to its action', () => {
    const run = actions()
    const menu = buildTrayMenu({ needsYou: 1, routinesPaused: true }, run)
    for (const item of menu) item.click?.()

    expect(run.open).toHaveBeenCalledOnce()
    expect(run.quickAsk).toHaveBeenCalledOnce()
    expect(run.showNeedsYou).toHaveBeenCalledOnce()
    expect(run.toggleRoutines).toHaveBeenCalledOnce()
    expect(run.quit).toHaveBeenCalledOnce()
  })

  it('reads as a checkbox when routines are paused', () => {
    const paused = buildTrayMenu({ needsYou: 0, routinesPaused: true }, actions())
    const item = paused.find((entry) => entry.label === 'Resume routines')
    expect(item).toMatchObject({ type: 'checkbox', checked: true })
  })
})
