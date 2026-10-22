/**
 * The mock bridge's global shortcuts and dictation pill, for the browser preview and screenshots.
 *
 * `?pill=listening|clean|cleaning|done|notice|error` puts the pill (route `#/dictation`) in that state so it can be
 * looked at without a microphone or a key. Shortcut statuses follow the settings the mock holds.
 */
import type { AgentApi, DictationView, HotkeyStatus, Settings, Unsubscribe } from '@agent/core'

const PILLS: Record<string, DictationView> = {
  listening: {
    phase: 'listening',
    clean: false,
    text: 'Remind me to send the proposal to Thandi before the',
    interim: 'meeting on Friday',
    message: '',
    switchKeys: 'Alt+C',
  },
  clean: {
    phase: 'listening',
    clean: true,
    text: 'So um I think we should, like, move the launch to',
    interim: 'the second week of November',
    message: '',
    switchKeys: 'Alt+C',
  },
  cleaning: { phase: 'cleaning', clean: true, text: 'So um I think we should, like, move the launch to the second week of November', interim: '', message: '', switchKeys: '' },
  done: { phase: 'done', clean: false, text: '', interim: '', message: 'Typed', switchKeys: '' },
  notice: { phase: 'notice', clean: false, text: '', interim: '', message: 'Add a Gemini key in Settings, Voice, to dictate.', switchKeys: '' },
  error: { phase: 'error', clean: false, text: '', interim: '', message: 'The microphone is off or blocked. Allow it for Agent in your system settings.', switchKeys: '' },
}

const LABELS = { quickAsk: 'Quick chat', dictate: 'Dictation', dictateClean: 'Dictate and clean up' } as const

/** `?blocked=dictate` shows Dictation held by another app, as on a PC where Wispr Flow still runs. */
const blockedAction = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('blocked')

function statuses(settings: Settings): HotkeyStatus[] {
  return (['quickAsk', 'dictate', 'dictateClean'] as const).map((action) => {
    if (action === blockedAction) {
      return {
        action,
        accelerator: settings.dictateHotkey,
        ok: false,
        message: 'Alt+Space is being used by Wispr Flow. Quit Wispr Flow or change its shortcut, and this starts working by itself.',
      }
    }
    const accelerator =
      action === 'quickAsk' ? settings.quickAskHotkey : action === 'dictate' ? settings.dictateHotkey : settings.dictateCleanHotkey
    return accelerator.trim() === ''
      ? { action, accelerator, ok: false, message: `${LABELS[action]} has no shortcut.` }
      : { action, accelerator, ok: true, message: 'Ready.' }
  })
}

export function mockHotkeys(settings: () => Settings): Pick<AgentApi, 'hotkeys' | 'dictation'> {
  const pill = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('pill')
  return {
    hotkeys: {
      async status() {
        return statuses(settings())
      },
      async pause() {
        return undefined
      },
    },
    dictation: {
      audio() {
        return undefined
      },
      async micState() {
        return undefined
      },
      async stop() {
        return undefined
      },
      async ready() {
        return undefined
      },
      onCommand(): Unsubscribe {
        return () => undefined
      },
      async toggle() {
        throw new Error('The preview has no dictation anywhere.')
      },
      async cancel() {
        return undefined
      },
      async retry() {
        return undefined
      },
      onDraft(): Unsubscribe {
        return () => undefined
      },
      onView(callback): Unsubscribe {
        const view = pill === null ? undefined : PILLS[pill]
        const timer = view === undefined ? null : setTimeout(() => callback(view), 50)
        return () => {
          if (timer !== null) clearTimeout(timer)
        }
      },
    },
  }
}
