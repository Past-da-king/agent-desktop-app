/**
 * The tray menu, kept as a pure list of items so its labels, order and enabled state can be tested
 * without Electron. `tray.ts` turns these into the real menu.
 */

export interface TrayMenuState {
  /** Question and approval cards waiting for the person. */
  needsYou: number
  routinesPaused: boolean
}

export interface TrayMenuActions {
  open(): void
  quickAsk(): void
  showNeedsYou(): void
  toggleRoutines(): void
  quit(): void
}

export interface TrayMenuItem {
  label?: string
  type?: 'normal' | 'separator' | 'checkbox'
  checked?: boolean
  enabled?: boolean
  click?: () => void
}

export function buildTrayMenu(state: TrayMenuState, actions: TrayMenuActions): TrayMenuItem[] {
  const items: TrayMenuItem[] = [
    { label: 'Open Agent', click: actions.open },
    { label: 'Quick Ask', click: actions.quickAsk },
  ]

  if (state.needsYou > 0) {
    items.push({
      label: `Needs you (${state.needsYou})`,
      click: actions.showNeedsYou,
    })
  }

  items.push(
    { type: 'separator' },
    {
      label: state.routinesPaused ? 'Resume routines' : 'Pause routines',
      type: 'checkbox',
      checked: state.routinesPaused,
      click: actions.toggleRoutines,
    },
    { type: 'separator' },
    { label: 'Quit', click: actions.quit },
  )

  return items
}
