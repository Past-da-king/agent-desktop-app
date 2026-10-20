/**
 * One place for the product identity. Window titles, the tray tooltip, notifications and the About
 * dialog all read from here so a rename cannot leave one surface behind.
 */
import type { AppInfo, AppPlatform } from '@agent/core'

/** Placeholder product name. Change this one constant to rename the app everywhere. */
export const APP_NAME = 'Agent'

/**
 * The Windows application user model id. Notifications and the taskbar group by it, so toasts show
 * the app's own name rather than "electron.app.Electron". Keep it in step with electron-builder.yml.
 */
export const APP_ID = 'app.agent.desktop'

/**
 * The Electron licence. The About dialog links here rather than naming a project website this
 * repository does not own yet. Replace it with the project's NOTICE page before public release.
 */
export const LICENCES_URL = 'https://github.com/electron/electron/blob/main/LICENSE'

export function windowTitle(): string {
  return APP_NAME
}

export function trayTooltip(): string {
  return APP_NAME
}

export function notificationTitle(): string {
  return APP_NAME
}

export interface AppInfoInput {
  version: string
  platform: AppPlatform
  electron: string
  logsPath: string
}

export function makeAppInfo(input: AppInfoInput): AppInfo {
  return {
    name: APP_NAME,
    version: input.version || '0.0.0',
    platform: input.platform,
    electron: input.electron || '0.0.0',
    logsPath: input.logsPath,
    licencesUrl: LICENCES_URL,
  }
}
