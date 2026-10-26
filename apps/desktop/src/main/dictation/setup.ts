/**
 * Puts dictation anywhere together for the app: the pill window, the live transcriber with the person's Gemini
 * key, the clean-up model and the paste helper. `index.ts` only creates it and hands it the shortcut manager.
 */
import { BrowserWindow, ClipboardItem, app, clipboard, type WebContents } from 'electron'

import type { DictationView } from '@agent/core'

import type { HotkeyManager } from '../hotkeys'
import { cleanSwitchAccelerator } from '../hotkeys'
import { formatAccelerator } from '../hotkey'
import type { SocketFactory, SocketLike } from '../voice/live'
import { LIVE_URL } from '../voice/gemini'
import type { VoiceService } from '../voice/service'
import { applyAliases, EMPTY_VOCABULARY, vocabularyBrief, type Vocabulary } from '../memory/vocabulary'
import type { Recordings } from '../recordings/store'
import { CLEANUP_MODELS, cleanUp } from './cleanup'
import { DictationController, type BatchResult } from './controller'
import { electronClipboard, keySenderFor, typeText, type KeySender, type TypeOutcome } from './paste'
import { PillWindow, type PillOptions } from './pill'
import { dictationTarget, type DictationSurface } from './target'
import { EVENTS } from '../../shared/channels'
import { safeSend } from '../alive'
import { LiveTranscriber, TRANSCRIBE_LIVE_MODELS, cleanVocabulary, languageHint, replayRecording } from './transcriber'

export interface DictationSetup {
  controller: DictationController
  pill: PillWindow
  keys: KeySender | null
  /** The message box's microphone in one of the app's windows: the words go into that window (and its chat). */
  toggleFrom(sender: WebContents, mode: 'plain' | 'clean', chat?: string | null): void
  /** A whole saved recording to text, the way a dictation's fallback does it (bounded by `signal`). */
  transcribe(pcm: Buffer, signal: AbortSignal): Promise<BatchResult>
  dispose(): void
}

/** A kept recording up to this long is sent again through the live model; longer ones in one call. */
const REPLAY_MAX_BYTES = 16_000 * 2 * 60

export interface DictationSetupDeps {
  voice: VoiceService
  geminiKey: () => string | null
  hotkeys: () => HotkeyManager | null
  pill: PillOptions
  locale: string
  log: (message: string, fields?: Record<string, string | number | boolean>) => void
  /** The names memory knows and their mis-hearings (memory/vocabulary.ts). */
  vocabulary?: () => Promise<Vocabulary>
  /** More words the person says that should be spelled right: project names, their own name. */
  extraWords?: () => Promise<string[]>
  /** Every dictation written to disk as it happens (recordings/store.ts). */
  recordings?: Pick<Recordings, 'begin'>
}

/** Node's own WebSocket (Node 22+, so Electron's main process has it). */
const nodeSocket: SocketFactory = (url) => {
  const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => SocketLike }).WebSocket
  if (Ctor === undefined) throw new Error('This build has no WebSocket support.')
  return new Ctor(url)
}

/**
 * Test hooks for a side-by-side test copy (its own AGENT_USER_DATA, AGENT_DICTATION_TEST=1), or development:
 * AGENT_DICTATION_LIVE_URL points the live transcriber at a local stand-in (127.0.0.1 only), and
 * AGENT_DICTATION_LIMIT_MS shortens the finishing limit, so the time limit, Cancel and Retry can be driven on a
 * real build. An installed copy with its normal data folder ignores both.
 */
function testHooks(): boolean {
  if (!app.isPackaged) return true
  return process.env['AGENT_DICTATION_TEST'] === '1' && (process.env['AGENT_USER_DATA']?.trim() ?? '') !== ''
}

function liveUrl(): string {
  const override = process.env['AGENT_DICTATION_LIVE_URL']
  return testHooks() && override !== undefined && /^wss?:\/\/127\.0\.0\.1:\d+\//.test(override) ? override : LIVE_URL
}

function testLimitMs(): number | null {
  const value = Number(process.env['AGENT_DICTATION_LIMIT_MS'] ?? '')
  return testHooks() && Number.isFinite(value) && value >= 1000 ? value : null
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
  // The same window, for the words while they are said; kept until the dictation's last view (a Retry uses it too).
  let draftTarget: BrowserWindow | null = null
  // A window whose own microphone button started this dictation, and the chat that button belongs to.
  let requestedBy: BrowserWindow | null = null
  let requestedChat: string | null = null
  // What the current dictation is written to disk as: which microphone path, and the chat it was for.
  let recordAs: { source: 'mic' | 'shortcut'; chat: string | null } = { source: 'shortcut', chat: null }
  // Into one of those windows ('app': its strip shows the words, never the pill), or into another app ('pill').
  let surface: DictationSurface = 'pill'
  const focusedOwn = (): BrowserWindow | null => {
    const focused = BrowserWindow.getFocusedWindow()
    return focused !== null && !focused.isDestroyed() && !pill.isPill(focused.webContents.id) ? focused : null
  }

  // The words the recogniser should lean towards, from memory and projects: read as a dictation starts, so the
  // next one has them at hand without waiting (the first one after launch uses the copy read at warm-up).
  let words: string[] = []
  const refreshWords = async (): Promise<string[]> => {
    try {
      const vocabulary = (await deps.vocabulary?.().catch(() => null)) ?? EMPTY_VOCABULARY
      const extra = (await deps.extraWords?.().catch(() => [])) ?? []
      words = cleanVocabulary([...extra, ...vocabulary.names, ...vocabulary.aliases.map((alias) => alias.name)])
    } catch {
      // Keep the last list.
    }
    return words
  }
  void refreshWords()

  const sendDraft = (view: DictationView): void => {
    const target = draftTarget
    safeSend(target, EVENTS.dictationDraft, view)
    if (view.phase === 'hidden') draftTarget = null
  }
  const pillWithDraft = {
    show: () => pill.show(),
    hide: () => {
      pill.hide()
      sendDraft({ phase: 'hidden', clean: false, text: '', interim: '', message: '', switchKeys: '' })
    },
    view: (view: DictationView) => {
      pill.view(view)
      sendDraft(view)
    },
    command: (command: Parameters<PillWindow['command']>[0]) => pill.command(command),
  }

  const controller = new DictationController({
    began: () => {
      const picked = dictationTarget<BrowserWindow>({
        requested: requestedBy,
        focused: BrowserWindow.getFocusedWindow(),
        isDestroyed: (window) => window.isDestroyed(),
        isPill: (window) => pill.isPill(window.webContents.id),
      })
      recordAs = requestedBy !== null ? { source: 'mic', chat: requestedChat } : { source: 'shortcut', chat: null }
      requestedBy = null
      requestedChat = null
      ownTarget = picked.target
      draftTarget = ownTarget
      surface = picked.surface
      deps.log('Dictation target', { surface })
      void refreshWords()
    },
    surface: () => surface,
    record: (where) =>
      deps.recordings?.begin({ source: recordAs.source, chat: recordAs.chat, target: where === 'app' ? 'this app' : 'another app' }) ?? null,
    hasKey: () => key() !== null,
    transcriber: (handlers) =>
      new LiveTranscriber({
        url: liveUrl(),
        key: key() ?? '',
        model: TRANSCRIBE_LIVE_MODELS[0] ?? 'gemini-3.5-transcribe-live',
        socket: nodeSocket,
        languageCodes: languageHint(deps.locale),
        vocabulary: () => words,
        onUpdate: handlers.onUpdate,
        onDrop: handlers.onDrop,
      }),
    batch: (pcm, signal, onUpdate) => batch(pcm, signal, onUpdate),
    cleanUp: async (text) => cleanUp({ key }, text, CLEANUP_MODELS, vocabularyBrief((await deps.vocabulary?.().catch(() => null)) ?? EMPTY_VOCABULARY)),
    fixNames: async (text) => applyAliases(text, (await deps.vocabulary?.().catch(() => null)) ?? EMPTY_VOCABULARY),
    type: async (text) => typeInto(text),
    mask: () => keys?.mask(),
    pill: pillWithDraft,
    hold: (accelerator, callback) => deps.hotkeys()?.hold(accelerator, callback) ?? null,
    keys: () => {
      const dictate = deps.hotkeys()?.bindings().dictate ?? ''
      return { dictate, cleanSwitch: dictate === '' ? null : cleanSwitchAccelerator(dictate) }
    },
    format: (accelerator) => formatAccelerator(accelerator),
    ...(testLimitMs() === null ? {} : { finishLimitMs: () => testLimitMs() ?? 30_000 }),
    log: deps.log,
  })

  async function batch(pcm: Buffer, signal: AbortSignal, onUpdate?: (text: string, interim: string) => void): Promise<BatchResult> {
    const names = words
    // A short recording goes through the live model again (quick, and the names apply); a long one, or one the
    // live model will not take, in one call. Both stop when `signal` aborts.
    if (pcm.length <= REPLAY_MAX_BYTES) {
      try {
        const text = await replayRecording({
          url: liveUrl(),
          key: key() ?? '',
          model: TRANSCRIBE_LIVE_MODELS[0] ?? 'gemini-3.5-transcribe-live',
          socket: nodeSocket,
          languageCodes: languageHint(deps.locale),
          vocabulary: names,
          pcm,
          signal,
          ...(onUpdate === undefined ? {} : { onUpdate }),
        })
        if (text.trim() !== '') return { ok: true, text }
      } catch (error) {
        if (signal.aborted) return { ok: false, error: 'Cancelled.' }
        deps.log('Dictation replay failed', { reason: error instanceof Error ? error.message : 'unknown' })
      }
    }
    return deps.voice.transcribe(pcm, { names, signal })
  }

  async function typeInto(text: string): Promise<TypeOutcome | 'inserted'> {
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
  }

  return {
    controller,
    pill,
    keys,
    toggleFrom: (sender, mode, chat) => {
      const window = BrowserWindow.fromWebContents(sender)
      if (controller.phase === 'idle') {
        requestedBy = window !== null && !pill.isPill(sender.id) ? window : null
        requestedChat = requestedBy === null ? null : (chat ?? null)
      }
      controller.toggle(mode)
    },
    transcribe: (pcm, signal) => batch(pcm, signal),
    dispose: () => {
      controller.dispose()
      pill.destroy()
      keys?.dispose()
    },
  }
}
