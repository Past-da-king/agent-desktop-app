/**
 * The tray icon and its menu (PLAN.md M8). Closing the window can leave the app running here, which
 * is what keeps routines going; Quit really quits.
 *
 * The menu itself is built by `tray-menu.ts`, which is pure and tested; this file only talks to Electron.
 */
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'

import {
  buildTrayMenu,
  type TrayMenuActions,
  type TrayMenuItem,
  type TrayMenuState,
} from './tray-menu'

export interface TrayOptions {
  iconPath: string
  tooltip: string
  state(): TrayMenuState
  actions: TrayMenuActions
  onError?: (error: unknown) => void
}

export interface TrayHandle {
  refresh(): void
  destroy(): void
}

/** Null when the desktop has no tray (some Linux sessions), so the app still starts. */
export function createTray(options: TrayOptions): TrayHandle | null {
  try {
    const image = nativeImage.createFromPath(options.iconPath)
    const tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
    tray.setToolTip(options.tooltip)

    const refresh = (): void => {
      if (tray.isDestroyed()) return
      const template: MenuItemConstructorOptions[] = buildTrayMenu(options.state(), options.actions).map(
        toElectronItem,
      )
      tray.setContextMenu(Menu.buildFromTemplate(template))
    }

    tray.on('click', () => options.actions.open())
    tray.on('double-click', () => options.actions.open())
    refresh()

    return {
      refresh,
      destroy: () => {
        if (!tray.isDestroyed()) tray.destroy()
      },
    }
  } catch (error) {
    options.onError?.(error)
    return null
  }
}

function toElectronItem(item: TrayMenuItem): MenuItemConstructorOptions {
  if (item.type === 'separator') return { type: 'separator' }
  return {
    label: item.label ?? '',
    type: item.type ?? 'normal',
    checked: item.checked,
    enabled: item.enabled ?? true,
    click: item.click,
  }
}
