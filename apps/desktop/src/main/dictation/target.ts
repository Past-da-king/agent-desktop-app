/**
 * Where a dictation goes, and so what shows it. One of the app's own windows (the main window, the quick chat
 * box) shows the words in its own strip above the message box and gets them typed in: no pill. Anything else
 * (another app in front) gets the floating pill and the words typed where its cursor is.
 * No Electron here, so the rule is tested on its own.
 */
export type DictationSurface = 'app' | 'pill'

export interface TargetInput<W> {
  /** The window whose own microphone button started it, if one did. */
  requested: W | null
  /** The focused window when it started (null when another app is in front). */
  focused: W | null
  isDestroyed: (window: W) => boolean
  isPill: (window: W) => boolean
}

export function dictationTarget<W>(input: TargetInput<W>): { target: W | null; surface: DictationSurface } {
  const usable = (window: W | null): window is W => window !== null && !input.isDestroyed(window) && !input.isPill(window)
  const target = usable(input.requested) ? input.requested : usable(input.focused) ? input.focused : null
  return { target, surface: target === null ? 'pill' : 'app' }
}
