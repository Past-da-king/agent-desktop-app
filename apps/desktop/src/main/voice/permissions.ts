/**
 * The microphone for voice. Electron grants every permission when no handler is set, so this sets one
 * that keeps that behaviour for everything else and allows media only as audio, only for the app's own
 * window. The camera is never granted: voice does not need it.
 */
import type { Session } from 'electron'

export function allowMicrophone(
  session: Pick<Session, 'setPermissionRequestHandler'>,
  isAppWindow: (id: number) => boolean,
): void {
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== 'media') {
      callback(true)
      return
    }
    const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
    callback(mediaAllowed(isAppWindow(webContents.id), types))
  })
}

export function mediaAllowed(appWindow: boolean, mediaTypes: string[]): boolean {
  if (!appWindow) return false
  return mediaTypes.length > 0 && mediaTypes.every((type) => type === 'audio')
}
