/**
 * Hiding a window from screen sharing (10 Nov 2026), the part that is plain data: can this computer really take a
 * window out of a screen capture, and what each setting's row may honestly say about it. Pure, so the main process,
 * the Settings page and the tests read the same answer.
 *
 * What the system gives (Electron's setContentProtection):
 *   - Windows 10 version 2004 (build 19041) and newer: SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE). The window
 *     is left out of every capture (Teams, Meet, Zoom, a screenshot).
 *   - older Windows: the window is captured as a black box. That hides what it says but shows that something is
 *     there, so it does not count as hidden here.
 *   - macOS: NSWindowSharingNone. Recorders built on the newer capture API (macOS 15 and later) can still capture
 *     such a window, so it is used but never promised.
 *   - Linux: nothing.
 * Content protection is per WINDOW, never per region: a part of a window cannot be hidden by itself.
 */

/** 'full': left out of every capture. 'partial': asked for, not guaranteed. 'none': the system cannot do it. */
export type CaptureExclusion = 'full' | 'partial' | 'none'

/** The first Windows build with WDA_EXCLUDEFROMCAPTURE (Windows 10 version 2004). */
export const WINDOWS_EXCLUDE_BUILD = 19041

/** `release` is os.release(): "10.0.26200" on Windows. Unknown or unreadable counts as too old. */
export function captureExclusion(platform: string, release = ''): CaptureExclusion {
  if (platform === 'darwin') return 'partial'
  if (platform !== 'win32') return 'none'
  const parts = release.split('.').map((part) => Number.parseInt(part, 10))
  const major = parts[0] ?? Number.NaN
  const build = parts[2] ?? Number.NaN
  if (!Number.isFinite(major) || !Number.isFinite(build)) return 'none'
  if (major > 10) return 'full'
  return major === 10 && build >= WINDOWS_EXCLUDE_BUILD ? 'full' : 'none'
}

/** Guides are drawn in their own protected window only where that hides them for real (or, on macOS, mostly). */
export function guidesUseOverlay(setting: boolean, exclusion: CaptureExclusion): boolean {
  return setting && exclusion !== 'none'
}

/**
 * The line under "Hide guides from screen sharing". The Settings page only knows the platform (not the build), so the
 * Windows line names the version it needs instead of claiming it.
 */
export function guidesHint(platform: string): string {
  if (platform === 'win32') return 'The highlight and its label are left out of Teams, Meet and Zoom, and you still see them. Needs Windows 10 version 2004 or newer; on older Windows they are drawn in the page and a screen share shows them.'
  if (platform === 'darwin') return 'The highlight and its label are kept out of most screen sharing, and you still see them. Some recorders on macOS 15 and newer can still capture them.'
  return 'Not available on this system: the highlight and its label are drawn in the page, so a screen share shows them.'
}

/** The line under "Hide the chat from screen sharing". */
export function chatHint(platform: string): string {
  if (platform === 'win32') return 'A window can only be hidden whole. While the chat is part of the app window, this hides the whole window, the browser included. Needs Windows 10 version 2004 or newer.'
  if (platform === 'darwin') return 'A window can only be hidden whole. While the chat is part of the app window, this hides the whole window, the browser included. Some recorders on macOS 15 and newer can still capture it.'
  return 'Not available on this system: a screen share shows the chat.'
}

/** What a window is, for the rule below. */
export type CaptureRole = 'guide' | 'chat' | 'main'

export interface CaptureSettings {
  hideGuidesFromCapture: boolean
  hideChatFromCapture: boolean
}

/**
 * Should a window of this role be hidden from capture now?
 *   - guide: the guide's own overlay window, by its setting.
 *   - chat: a window that shows only the chat (Quick ask; a docked chat once it has a window of its own).
 *   - main: the app window. It holds the chat today, so "hide the chat" can only hide all of it. The moment the main
 *     window's chat lives in a window of its own (`chatHasOwnWindow`), the app window is left alone.
 */
export function shouldProtect(role: CaptureRole, settings: CaptureSettings, state: { chatHasOwnWindow: boolean }): boolean {
  if (role === 'guide') return settings.hideGuidesFromCapture
  if (role === 'chat') return settings.hideChatFromCapture
  return settings.hideChatFromCapture && !state.chatHasOwnWindow
}
