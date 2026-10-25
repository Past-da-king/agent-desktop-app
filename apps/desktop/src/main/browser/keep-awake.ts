/**
 * The agent's pages keep running when nobody is looking at them (25 Oct 2026).
 *
 * Agents browse with the panel hidden, the window minimised, behind other windows or closed to the tray. Chromium
 * treats every one of those as "in the background": it lowers the page's process priority (on a busy Windows PC the
 * page then gets almost no CPU), throttles its timers to once a minute, and on Windows marks a covered window as
 * hidden. Measured on 0.2.77 with the window minimised: one browser_open took 336 s, a 2 s page timer took 14 s,
 * and screenshots failed. These switches keep the pages awake; the agent's own pages also run with
 * backgroundThrottling off (embed.ts, browser.ts), and so does the main window that hosts them, so its <webview>s
 * are still created and attached while it is minimised.
 *
 * Pure apart from the command line it is handed, so it is tested without Electron.
 */

/** Switches that keep background renderers at full speed. */
export const KEEP_AWAKE_SWITCHES = [
  // A page in a hidden or minimised window keeps its normal process priority.
  'disable-renderer-backgrounding',
  // Its timers are not slowed down.
  'disable-background-timer-throttling',
  // A window covered by other windows is not treated as hidden.
  'disable-backgrounding-occluded-windows',
] as const

/** Features that slow or hide background pages, switched off. */
export const KEEP_AWAKE_DISABLED_FEATURES = [
  // Windows' own occlusion tracking marks a covered window hidden, which stops its pages painting.
  'CalculateNativeWinOcclusion',
  // After five minutes hidden, chained timers run at most once a minute.
  'IntensiveWakeUpThrottling',
] as const

export interface CommandLineLike {
  appendSwitch(name: string, value?: string): void
  hasSwitch(name: string): boolean
  getSwitchValue(name: string): string
}

/** Applies the switches once, before the app is ready. Keeps any features already disabled. */
export function keepPagesAwake(commandLine: CommandLineLike): void {
  for (const name of KEEP_AWAKE_SWITCHES) {
    if (!commandLine.hasSwitch(name)) commandLine.appendSwitch(name)
  }
  const existing = commandLine.hasSwitch('disable-features')
    ? commandLine
        .getSwitchValue('disable-features')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '')
    : []
  const merged = [...new Set([...existing, ...KEEP_AWAKE_DISABLED_FEATURES])]
  commandLine.appendSwitch('disable-features', merged.join(','))
}

/** The main window's own setting: it hosts the agent's pages, so it is never throttled either. */
export const HOST_WINDOW_PREFS = { backgroundThrottling: false } as const
