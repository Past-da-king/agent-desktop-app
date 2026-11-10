/**
 * Where the app gets its screen reader ("show me how"). ONE line changes when the native layer lands:
 *
 *   import { createScreenReader } from './native'
 *   export function appScreenReader(options: ReaderOptions): ScreenReader { return createScreenReader(options) }
 *
 * Until then there is none, and a walk says so plainly instead of starting. The native layer may make that change
 * itself, here; nothing else in the engine or in main/index.ts needs to move.
 */
import { noScreenReader, type ScreenReader } from './screen'

export interface ReaderOptions {
  log?: (message: string, detail?: Record<string, unknown>) => void
}

export function appScreenReader(_options: ReaderOptions = {}): ScreenReader {
  return noScreenReader()
}
