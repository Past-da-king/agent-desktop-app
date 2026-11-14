/**
 * The native side of "show me how": createScreenReader() gives the engine a ScreenReader (../screen.ts) for
 * this computer. Windows has a real one (./windows.ts, through the agent-screen helper); anywhere else, or when
 * the helper is missing, it gives one that says it is not available and why, and never throws from available().
 */
import { join } from 'node:path'

import { findScreenSidecar, ScreenReadError } from './sidecar'
import type { ScreenSidecarLookup } from './sidecar'
import { createWindowsScreenReader } from './windows'
import type { NativeScreenReader, ScreenReaderOptions } from './windows'

export { findScreenSidecar, ScreenReadError } from './sidecar'
export type { ScreenSidecarLookup, SpawnLike } from './sidecar'
export type { NativeActiveWindow, NativeScreenReader, ScreenDisplay, ScreenMonitor, ScreenReaderOptions } from './windows'

export interface CreateScreenReaderOptions extends Partial<ScreenReaderOptions> {
  /** Where to look for the helper when `binary` is not given: process.resourcesPath, the repo in development. */
  lookup?: ScreenSidecarLookup
  platform?: string
}

function unavailable(reason: string): NativeScreenReader {
  const refuse = (): Promise<never> => Promise.reject(new ScreenReadError('unavailable', reason))
  return {
    unavailableReason: () => reason,
    available: () => Promise.resolve(false),
    activeWindow: () => Promise.resolve(null),
    window: () => Promise.resolve(null),
    windows: () => Promise.resolve([]),
    monitors: () => Promise.resolve([]),
    tree: refuse,
    find: refuse,
    watch: (_hwnd, _node, onMove) => {
      onMove(null)
      return () => undefined
    },
    capture: refuse,
    onInput: () => () => undefined,
    onScroll: () => () => undefined,
    focus: () => Promise.resolve(false),
    setKeys: () => undefined,
    idleMs: () => Promise.resolve(-1),
    call: refuse,
    helperState: () => Promise.resolve(null),
    dispose: () => undefined,
  }
}

/** Where the helper is when nobody says: packed beside the app, else in the repo the app runs from. */
function defaultLookup(): ScreenSidecarLookup {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  const cwd = process.cwd()
  return { ...(typeof resourcesPath === 'string' ? { resourcesPath } : {}), dirs: [cwd, join(cwd, '..', '..')] }
}

/**
 * The screen reader for this computer. With no options it finds the helper itself (the packed app's resources,
 * then the repo in development) and leaves this process's own windows out. `displays` (the caller's display ids
 * in physical pixels) is only needed for ActiveWindow.displayId and capture({ displayId }).
 */
export function createScreenReader(options: CreateScreenReaderOptions = {}): NativeScreenReader {
  const platform = options.platform ?? process.platform
  // A test passes its own spawn and binary and runs anywhere.
  if (platform !== 'win32' && options.spawn === undefined) return unavailable('Showing steps on other windows works on Windows only for now.')
  const { lookup, platform: _platform, ...rest } = options
  void _platform
  let found: string | null | undefined
  const binary = rest.binary ?? ((): string | null => (found === undefined ? (found = findScreenSidecar(lookup ?? defaultLookup())) : found))
  return createWindowsScreenReader({ ...rest, binary })
}
