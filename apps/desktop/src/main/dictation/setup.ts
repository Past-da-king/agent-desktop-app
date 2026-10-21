/**
 * Puts dictation anywhere together for the app: the pill window, the live transcriber with the person's Gemini
 * key, the clean-up model and the paste helper. `index.ts` only creates it and hands it the shortcut manager.
 */
import { BrowserWindow, ClipboardItem, app, clipboard } from 'electron'

import type { HotkeyManager } from '../hotkeys'
import { cleanSwitchAccelerator } from '../hotkeys'
import { formatAccelerator } from '../hotkey'
import type { SocketFactory, SocketLike } from '../voice/live'
import { LIVE_URL } from '../voice/gemini'
import type { VoiceService } from '../voice/service'
import { applyAliases, EMPTY_VOCABULARY, vocabularyBrief, type Vocabulary } from '../memory/vocabulary'
import { CLEANUP_MODELS, cleanUp } from './cleanup'
import { DictationController } from './controller'
import { electronClipboard, keySenderFor, typeText, type KeySender } from './paste'
import { PillWindow, type PillOptions } from './pill'
import { LiveTranscriber, TRANSCRIBE_LIVE_MODELS, languageHint } from './transcriber'

export interface DictationSetup {
  controller: DictationController
  pill: PillWindow
  keys: KeySender | null
  dispose(): void
}

export interface DictationSetupDeps {
  voice: VoiceService
  geminiKey: () => string | null
  hotkeys: () => HotkeyManager | null
  pill: PillOptions
  locale: string
  log: (message: string, fields?: Record<string, string | number | boolean>) => void
  /** The names memory knows and their mis-hearings (memory/vocabulary.ts). */
  vocabulary?: () => Promise<Vocabulary>
}

/** Node's own WebSocket (Node 22+, so Electron's main process has it). */
const nodeSocket: SocketFactory = (url) => {
  const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => SocketLike }).WebSocket
  if (Ctor === undefined) throw new Error('This build has no WebSocket support.')
  return new Ctor(url)
}

/**
 * In development only, AGENT_DICTATION_LIVE_URL points the live transcriber at a local stand-in, so the whole
 * chain (pill, microphone, shortcuts, typing) can be driven without a Gemini key. Ignored in an installed build.
 */
function liveUrl(): string {
  const override = process.env['AGENT_DICTATION_LIVE_URL']
  return !app.isPackaged && override !== undefined && /^wss?:\/\/127\.0\.0\.1:\d+\//.test(override) ? override : LIVE_URL
}

export function createDictation(deps: DictationSetupDeps): DictationSetup {
  const pill = new PillWindow(deps.pill)
  const keys = keySenderFor(process.platform)
  const board = electronClipboard(clipboard, (entries) => new ClipboardItem(entries as ConstructorParameters<typeof ClipboardItem>[0]))
  const key = (): string | null => {
    const value = deps.geminiKey()
    return value === null || value.trim() === '' ? null : value.trim()
  }

  // One of the app's own windows that had the cursor when the dictation started (the quick chat box, the composer).
  let ownTarget: BrowserWindow | null = null
  const focusedOwn = (): BrowserWindow | null => {
    const focused = BrowserWindow.getFocusedWindow()
    return focused !== null && !focused.isDestroyed() && !pill.isPill(focused.webContents.id) ? focused : null
  }

  const controller = new DictationController({
    began: () => {
      ownTarget = focusedOwn()
    },
    hasKey: () => key() !== null,
    transcriber: (handlers) =>
      new LiveTranscriber({
        url: liveUrl(),
        key: key() ?? '',
        model: TRANSCRIBE_LIVE_MODELS[0] ?? 'gemini-3.5-transcribe-live',
        socket: nodeSocket,
        languageCodes: languageHint(deps.locale),
        onUpdate: handlers.onUpdate,
        onDrop: handlers.onDrop,
      }),
    batch: (pcm) => deps.voice.transcribe(pcm),
    cleanUp: async (text) => cleanUp({ key }, text, CLEANUP_MODELS, vocabularyBrief((await deps.vocabulary?.().catch(() => null)) ?? EMPTY_VOCABULARY)),
    fixNames: async (text) => applyAliases(text, (await deps.vocabulary?.().catch(() => null)) ?? EMPTY_VOCABULARY),
    type: async (text) => {
      // Into one of the app's own windows (the quick chat box, the composer): no clipboard needed.
      const target = ownTarget !== null && !ownTarget.isDestroyed() && ownTarget.isVisible() ? ownTarget : focusedOwn()
      ownTarget = null
      if (target !== null) {
        if (!target.isFocused()) target.focus()
        await target.webContents.insertText(text)
        return 'inserted'
      }
      const started = Date.now()
      const outcome = await typeText(text, { clipboard: board, keys })
      deps.log('Dictation paste', { outcome, ms: Date.now() - started })
      return outcome
    },
    mask: () => keys?.mask(),
    pill,
    hold: (accelerator, callback) => deps.hotkeys()?.hold(accelerator, callback) ?? null,
    keys: () => {
      const dictate = deps.hotkeys()?.bindings().dictate ?? ''
      return { dictate, cleanSwitch: dictate === '' ? null : cleanSwitchAccelerator(dictate) }
    },
    format: (accelerator) => formatAccelerator(accelerator),
    log: deps.log,
  })

  return {
    controller,
    pill,
    keys,
    dispose: () => {
      controller.dispose()
      pill.destroy()
      keys?.dispose()
    },
  }
}
