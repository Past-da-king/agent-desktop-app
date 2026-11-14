/**
 * Puts dictation anywhere together for the app: the pill window, the live transcriber with the person's Gemini
 * key, the clean-up model and the paste helper. `index.ts` only creates it and hands it the shortcut manager.
 */
import { randomBytes } from 'node:crypto'

import { BrowserWindow, ClipboardItem, app, clipboard, type WebContents } from 'electron'

import type { DictationView } from '@agent/core'

import type { HotkeyManager } from '../hotkeys'
import { cleanSwitchAccelerator } from '../hotkeys'
import { formatAccelerator } from '../hotkey'
import type { SocketFactory, SocketLike } from '../voice/live'
import { LIVE_URL } from '../voice/gemini'
import type { VoiceService } from '../voice/service'
import { applyAliases, EMPTY_VOCABULARY, vocabularyBrief, type Vocabulary } from '../memory/vocabulary'
import type { RecordingHandle, Recordings } from '../recordings/store'
import { CLEANUP_MODELS, cleanUp } from './cleanup'
import { DictationController, type BatchResult } from './controller'
import { transcribeInChunks } from './chunks'
import { addedNames, stripInjectedNames } from './injected'
import { respellNames } from './respell'
import { electronClipboard, keySenderFor, typeText, type KeySender, type TypeOutcome } from './paste'
import { PillWindow, type PillOptions } from './pill'
import { dictationTarget, type DictationSurface } from './target'
import { BoxDelivery, dictationRoute, type BoxTarget } from './box'
import { EVENTS } from '../../shared/channels'
import { safeSend } from '../alive'
import { LiveTranscriber, TRANSCRIBE_LIVE_MODELS, cleanVocabulary, speechLanguages } from './transcriber'

export interface DictationSetup {
  controller: DictationController
  pill: PillWindow
  keys: KeySender | null
  /** The message box's microphone in one of the app's windows: the words go into that window (and its chat). */
  toggleFrom(sender: WebContents, mode: 'plain' | 'clean', chat?: string | null): void
  /** A whole saved recording to text, the way a dictation's fallback does it (bounded by `signal`). */
  transcribe(pcm: Buffer, signal: AbortSignal): Promise<BatchResult>
  /** The dictation going into the window `sender` belongs to, for a window that just reloaded. */
  currentFor(sender: unknown): DictationView | null
  /** A window says whether the words it was sent are really there. */
  boxResult(sender: unknown, id: string, ok: boolean): void
  /** The list of dictations to offer back changed: every window of the app reads it again. */
  undeliveredChanged(): void
  dispose(): void
}

/** A recording up to this long goes to the speech model in one request (a base64 wav of it still fits inline). */
const WHOLE_MAX_BYTES = 16_000 * 2 * 60 * 3

export interface DictationSetupDeps {
  voice: VoiceService
  geminiKey: () => string | null
  hotkeys: () => HotkeyManager | null
  pill: PillOptions
  locale: string
  /** The person's own languages, English first (transcriber.ts speechLanguages); the app's system list. */
  languages?: () => string[]
  log: (message: string, fields?: Record<string, string | number | boolean>) => void
  /** The names memory knows and their mis-hearings (memory/vocabulary.ts). */
  vocabulary?: () => Promise<Vocabulary>
  /** More words the person says that should be spelled right: project names, their own name. */
  extraWords?: () => Promise<string[]>
  /** Every dictation written to disk as it happens (recordings/store.ts). */
  recordings?: Pick<Recordings, 'begin' | 'setDelivery'>
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
  // His own languages, from the system when the app can read them (index.ts hands them in), else its locale.
  const languages = (): string[] => deps.languages?.() ?? speechLanguages([], deps.locale)
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
  // This dictation on disk, for its delivery; null when nothing is written.
  let recording: RecordingHandle | null = null
  // Words on their way into a window, until it says they are there.
  const box = new BoxDelivery(EVENTS.dictationBoxText)
  const focusedOwn = (): BrowserWindow | null => {
    const focused = BrowserWindow.getFocusedWindow()
    return focused !== null && !focused.isDestroyed() && !pill.isPill(focused.webContents.id) ? focused : null
  }

  // The names to spell right after transcription, from memory and projects: read as a dictation starts, so the
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

  const withChat = (view: DictationView): DictationView => ({ ...view, chat: recordAs.source === 'mic' ? recordAs.chat : null })
  const undeliveredChanged = (): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !pill.isPill(window.webContents.id)) safeSend(window, EVENTS.dictationUndelivered, null)
    }
  }
  const sendDraft = (view: DictationView): void => {
    const target = draftTarget
    safeSend(target, EVENTS.dictationDraft, withChat(view))
    if (view.phase === 'hidden') draftTarget = null
    // A dictation that ended without its words landing may have left something to offer back.
    if (view.phase === 'error' || view.phase === 'notice') undeliveredChanged()
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
    record: (where) => {
      recording =
        deps.recordings?.begin({ source: recordAs.source, chat: recordAs.chat, target: where === 'app' ? 'this app' : 'another app', ...(where === 'app' ? { delivery: 'pending' as const } : {}) }) ?? null
      return recording
    },
    hasKey: () => key() !== null,
    transcriber: (handlers) =>
      new LiveTranscriber({
        url: liveUrl(),
        key: key() ?? '',
        model: TRANSCRIBE_LIVE_MODELS[0] ?? 'gemini-3.5-transcribe-live',
        socket: nodeSocket,
        languageCodes: languages(),
        // No name list: a recogniser biased towards names says them for unclear speech and into quiet stretches.
        // Names are spelled right afterwards (fixNames), and only for words that were said.
        onUpdate: handlers.onUpdate,
        onDrop: handlers.onDrop,
        onInjected: injected,
      }),
    batch: (pcm, signal, onUpdate) => batch(pcm, signal, onUpdate),
    cleanUp: async (text) => {
      const cleaned = await cleanUp({ key }, text, CLEANUP_MODELS, vocabularyBrief((await deps.vocabulary?.().catch(() => null)) ?? EMPTY_VOCABULARY))
      // Clean-up tidies; it never brings in a name that was not said. One that does is not used.
      const added = addedNames(text, cleaned, words)
      if (added.length > 0) {
        deps.log('Dictation clean-up added a name, typed as said', { names: added.length })
        throw new Error('The clean-up added a name')
      }
      return cleaned
    },
    fixNames: async (text) => spellNames(applyAliases(text, (await deps.vocabulary?.().catch(() => null)) ?? EMPTY_VOCABULARY), words),
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

  function injected(stretch: string): void {
    // Only its size: the words themselves stay out of the log.
    deps.log('Dictation left out a stretch of only names', { characters: stretch.length })
  }

  function withoutInjected(text: string, names: string[]): string {
    const stripped = stripInjectedNames(text, names)
    for (const stretch of stripped.dropped) injected(stretch)
    return stripped.text
  }

  /** Mis-heard names respelled (only words that were said), then any stretch of nothing but names left out. */
  function spellNames(text: string, names: string[]): string {
    const respelled = respellNames(text, names)
    if (respelled.changed.length > 0) deps.log('Dictation respelled names', { count: respelled.changed.length })
    return withoutInjected(respelled.text, names)
  }

  /** Every way a recording becomes text ends here, transcribed as heard and then names spelled right. */
  async function batch(pcm: Buffer, signal: AbortSignal, onUpdate?: (text: string, interim: string) => void): Promise<BatchResult> {
    const names = words
    const result = await batchRaw(pcm, signal, onUpdate)
    return result.ok ? { ok: true, text: spellNames(result.text, names) } : result
  }

  /**
   * The recording itself, through Google's speech model (11 Nov 2026).
   *
   * This, not the live captions, is what he gets typed: the same audio, read in one go by the model made for
   * transcribing, with his languages and his own names and projects. The live session is only what he watches while he
   * speaks. Nothing is sent through the live model a second time (that was the old fallback, and it is the same weaker
   * transcriber that got the words wrong in the first place).
   */
  async function batchRaw(pcm: Buffer, signal: AbortSignal, onUpdate?: (text: string, interim: string) => void): Promise<BatchResult> {
    const speech = { names: words, languageCodes: languages(), mode: 'verbatim' as const }
    // Up to about three minutes goes up as one request in one piece (a wav of it fits the inline limit); longer ones
    // in two-minute pieces cut at quiet moments, a couple at a time.
    if (pcm.length <= WHOLE_MAX_BYTES) {
      const whole = await deps.voice.transcribe(pcm, { ...speech, signal })
      if (whole.ok) return { ok: true, text: whole.text }
      if (signal.aborted) return { ok: false, error: 'Cancelled.' }
      deps.log('Dictation whole transcribe failed', { reason: whole.error })
      return { ok: false, error: whole.error }
    }
    return transcribeInChunks(pcm, (piece, pieceSignal) => deps.voice.transcribe(piece, { ...speech, signal: pieceSignal }), {
      signal,
      ...(onUpdate === undefined ? {} : { onUpdate }),
      log: deps.log,
    })
  }

  /**
   * The words into a window, confirmed by that window. Never `insertText` into whatever has the focus: that reports
   * success with no field in front, or with the cursor in the wrong one (30 Oct 2026: 1,980 characters "inserted").
   */
  async function intoWindow(target: BrowserWindow | null, into: 'box' | 'here', chat: string | null, text: string): Promise<'inserted' | 'unconfirmed'> {
    const id = recording?.id ?? `d-${randomBytes(4).toString('hex')}`
    const contents = target !== null && !target.isDestroyed() ? target.webContents : null
    const result = contents === null ? 'gone' : await box.deliver(contents as unknown as BoxTarget, { id, into, chat, text })
    if (result === 'confirmed') {
      await confirmed(contents, recording)
      return 'inserted'
    }
    deps.log('Dictation words not confirmed by the window', { result, into, characters: text.length })
    return 'unconfirmed'
  }

  async function confirmed(contents: WebContents | null, handle: RecordingHandle | null): Promise<void> {
    try {
      // What the window just stored goes to disk before the recording stops being offered back.
      await contents?.session.flushStorageData()
    } catch {
      // Chromium writes it itself a moment later.
    }
    await handle?.delivered('confirmed')
  }

  async function typeInto(text: string): Promise<TypeOutcome | 'inserted' | 'unconfirmed'> {
    const own = ownTarget !== null && !ownTarget.isDestroyed() && ownTarget.isVisible() ? ownTarget : focusedOwn()
    const route = dictationRoute({ source: recordAs.source, chat: recordAs.chat, ownWindow: own !== null })
    if (route.to === 'box') {
      // The message box's microphone: that chat's draft, whatever is on screen and wherever the cursor is.
      return intoWindow(ownTarget, 'box', route.chat, text)
    }
    ownTarget = null
    if (route.to === 'here' && own !== null) {
      if (!own.isFocused()) own.focus()
      return intoWindow(own, 'here', null, text)
    }
    const started = Date.now()
    const outcome = await typeText(text, { clipboard: board, keys })
    deps.log('Dictation paste', { outcome, ms: Date.now() - started })
    // The shortcut started in this app and he moved to another: the words went there.
    if (outcome === 'pasted') await recording?.delivered('confirmed')
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
    currentFor: (sender) => {
      if (draftTarget === null || draftTarget.isDestroyed() || draftTarget.webContents !== sender) return null
      const view = controller.currentView()
      return view.phase === 'hidden' ? null : withChat(view)
    },
    boxResult: (sender, id, ok) => {
      if (box.answer(id, ok) || !ok) return
      // The answer came after the limit: the words are there after all, so they stop being offered back.
      deps.log('Dictation words confirmed late', { id })
      void confirmed(sender as WebContents, null)
        .then(() => deps.recordings?.setDelivery(id, 'confirmed'))
        .then(undeliveredChanged)
    },
    undeliveredChanged,
    dispose: () => {
      controller.dispose()
      pill.destroy()
      keys?.dispose()
    },
  }
}
