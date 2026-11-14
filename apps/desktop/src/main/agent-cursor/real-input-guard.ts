/**
 * The agent never moves the person's pointer, sends keys to his foreground window or takes the focus (11 Nov 2026).
 * Real input exists in ONE place, the input lock (./input-lock.ts), which asks first and only runs when he is idle.
 * A shell command or a script that reaches for it directly is refused here, with the way to do it properly.
 */

/** The names that mean "real input on his desktop". Matched whole-word, case-insensitive. One list, one place. */
export const REAL_INPUT_NAMES: readonly string[] = [
  'SetCursorPos',
  'mouse_event',
  'keybd_event',
  'SendInput',
  'SendKeys',
  'SetForegroundWindow',
  'AppActivate',
  'pyautogui',
  'pynput',
  'xdotool',
  'nircmd',
  'AutoHotkey',
  'robotjs',
  'nutjs',
]

const PATTERN = new RegExp('(?<![A-Za-z0-9_])(' + REAL_INPUT_NAMES.join('|') + ')(?![A-Za-z0-9_])', 'i')

/** A command that only looks at files (grep, rg, Select-String, findstr) may name these words. */
const READING = /^\s*(?:git\s+grep|grep|egrep|rg|findstr|select-string|sls)\b/i

export const REAL_INPUT_MESSAGE =
  'Refused: this would move his mouse, press keys on his foreground window or take his focus. The agent never does that. Use screen_windows to find the window, screen_read to read it and screen_act to click, type or scroll in it: they reach one window without his cursor or focus. If a program takes only real input, screen_act says it needs the agent desktop.'

/** The name found, or null when the text is clean. */
export function realInputUse(text: string): string | null {
  if (text === '') return null
  const found = PATTERN.exec(text)
  if (found === null) return null
  if (READING.test(text) && !/[;&|]\s*(?:powershell|pwsh|python|node|cmd)\b/i.test(text)) return null
  return found[1] ?? null
}

/** The refusal to give back for a command or a script, or null when it may run. */
export function refuseRealInput(text: string): string | null {
  const name = realInputUse(text)
  return name === null ? null : REAL_INPUT_MESSAGE + ' (found: ' + name + ')'
}
