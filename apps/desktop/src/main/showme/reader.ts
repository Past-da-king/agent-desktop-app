/**
 * Where the app gets its screen reader ("show me how"): the native layer in ./native. On Windows that is the
 * agent-screen helper (tools/agent-screen); anywhere else, or when the helper is missing from the install, the
 * reader says it is not available and a walk says so plainly instead of starting.
 */
import { createScreenReader } from './native'
import type { ScreenReader } from './screen'

export interface ReaderOptions {
  log?: (message: string, detail?: Record<string, unknown>) => void
}

export function appScreenReader(options: ReaderOptions = {}): ScreenReader {
  return createScreenReader(options)
}
