/**
 * Turning a key press into an Electron accelerator, and back into something a person reads.
 * Pure so the recorder in Settings can be tested without a window.
 */

export interface KeyPress {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const NAMED: Record<string, string> = {
  ' ': 'Space',
  Spacebar: 'Space',
  Escape: 'Esc',
  Esc: 'Esc',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  '+': 'Plus',
}

const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'AltGraph', 'CapsLock'])

function keyName(event: KeyPress): string | null {
  if (MODIFIERS.has(event.key)) return null
  const named = NAMED[event.key]
  if (named !== undefined) return named
  if (event.key.length === 1) return event.key.toUpperCase()
  if (/^F\d{1,2}$/.test(event.key)) return event.key
  return null
}

/**
 * `CommandOrControl+Shift+Space` style. A shortcut needs at least one of Ctrl, Cmd or Alt;
 * Shift on its own is a capital letter, not a shortcut.
 */
export function acceleratorFromEvent(event: KeyPress, platform: string): string | null {
  if (!event.ctrlKey && !event.metaKey && !event.altKey) return null
  const name = keyName(event)
  if (name === null) return null

  const parts: string[] = []
  if (platform === 'darwin') {
    if (event.metaKey) parts.push('Command')
    if (event.ctrlKey) parts.push('Control')
  } else {
    if (event.ctrlKey) parts.push('CommandOrControl')
    if (event.metaKey) parts.push('Super')
  }
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  parts.push(name)
  return parts.join('+')
}

/** How the accelerator reads on screen: Ctrl on Windows and Linux, Cmd on a Mac. */
export function formatAccelerator(accelerator: string, platform: string): string[] {
  return accelerator
    .split('+')
    .map((part) => {
      const key = part.trim()
      if (key === '') return ''
      if (/^commandorcontrol$/i.test(key) || /^cmdorctrl$/i.test(key)) {
        return platform === 'darwin' ? 'Cmd' : 'Ctrl'
      }
      if (/^control$/i.test(key)) return 'Ctrl'
      if (/^command$/i.test(key) || /^cmd$/i.test(key)) return platform === 'darwin' ? 'Cmd' : 'Super'
      if (/^alt$/i.test(key) || /^option$/i.test(key)) return platform === 'darwin' ? 'Option' : 'Alt'
      if (/^shift$/i.test(key)) return 'Shift'
      if (/^plus$/i.test(key)) return '+'
      return key.length === 1 ? key.toUpperCase() : key
    })
    .filter((part) => part !== '')
}

/** The clean-up switch while dictating: the dictation shortcut's modifiers with C (Alt+Space gives Alt+C). Mirrors main. */
export function cleanSwitchKeys(dictate: string, platform: string): string {
  const parts = dictate
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length < 2 || (parts.at(-1) ?? '').toUpperCase() === 'C') return ''
  return formatAccelerator([...parts.slice(0, -1), 'C'].join('+'), platform).join('+')
}
