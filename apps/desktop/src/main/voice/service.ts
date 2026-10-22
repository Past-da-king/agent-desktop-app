/**
 * Voice in the main process: the Gemini key, dictation, read-aloud and the live call.
 *
 * The voice agent knows the person from the same prompt the main agent uses (memory, goals, tasks),
 * plus the last few chat messages, and hands real work to the main runner. When the call ends its
 * transcript lands in the chat as one compact `call` row; anything it showed is already there as an
 * agent message.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  CallEvent,
  CallSummary,
  CallVisual,
  ChatItem,
  DeviceCall,
  LiveTokenResult,
  EnvironmentReport,
  RunState,
  Settings,
  ToolContext,
  VoiceResult,
} from '@agent/core'

import { buildSystemPrompt } from '../runtime/prompt'
import type { DataStore } from '../runtime/data'
import { visualMarkdown, voiceTools } from '../tools/voice'
import {
  DEFAULT_CHOICE,
  LIVE_TOKEN_URL,
  LIVE_URL,
  mintLiveToken,
  checkKey,
  explain,
  speak as speakText,
  transcribe as transcribeAudio,
  voiceNoteAudio,
  wavOf,
  OUTPUT_RATE,
  type ModelChoice,
} from './gemini'
import { LiveSession, type SocketFactory, type SocketLike } from './live'

export interface VoiceSecrets {
  get(name: string): string | null
  set(name: string, value: string): void
  delete(name: string): void
}

export interface VoiceSettings {
  get(): Settings
  save(patch: Partial<Settings>): unknown
}

export interface VoiceRunner {
  send(text: string): Promise<void>
  state(): RunState
}

export interface VoiceDeps {
  secrets: VoiceSecrets
  settings: VoiceSettings
  store: DataStore
  runner: VoiceRunner
  emit: (event: CallEvent) => void
  socket?: SocketFactory
  fetchImpl?: typeof fetch
  now?: () => number
  platform?: string
  environment?: () => EnvironmentReport | null
  timeZone?: string
  /** Where voice notes are saved on this computer. */
  notesDir?: string
}

const KEY = 'geminiKey'

/** The longest one transcription call may take. */
export const TRANSCRIBE_MAX_MS = 90_000

/** How long a recording of `bytes` (16 kHz PCM16) may take to transcribe: 30 s, plus one for every two said. */
export function transcribeLimitMs(bytes: number): number {
  const seconds = bytes / (16_000 * 2)
  return Math.min(TRANSCRIBE_MAX_MS, Math.round(30_000 + seconds * 500))
}
const RECENT_CHAT = 12
const MAX_DICTATION_BYTES = 16_000 * 2 * 60 * 5 // five minutes
const MAX_CHUNK_BYTES = 64 * 1024

export class VoiceService {
  private readonly deps: VoiceDeps
  private readonly now: () => number
  private choice: ModelChoice = DEFAULT_CHOICE
  private checked = false
  private call: LiveSession | null = null
  private visuals: CallVisual[] = []
  private handoffs = 0

  constructor(deps: VoiceDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  private key(): string | null {
    const value = this.deps.secrets.get(KEY)
    return value === null || value.trim() === '' ? null : value.trim()
  }

  private gemini(): { key: () => string | null; fetchImpl?: typeof fetch } {
    return { key: () => this.key(), ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }) }
  }

  setKey(raw: string): void {
    const value = raw.trim()
    if (value === '') this.deps.secrets.delete(KEY)
    else this.deps.secrets.set(KEY, value)
    this.choice = DEFAULT_CHOICE
    this.deps.settings.save({ hasVoiceKey: value !== '' })
  }

  async check(): Promise<{ ok: boolean; message: string }> {
    const result = await checkKey(this.gemini())
    if (result.choice !== undefined) this.choice = result.choice
    this.checked = result.ok
    return { ok: result.ok, message: result.message }
  }

  /**
   * One recording to text in one call. Always bounded: `timeoutMs` (by default scaled to the recording, at most
   * TRANSCRIBE_MAX_MS) or `signal`, whichever comes first, ends it with a plain error instead of a wait that never ends.
   */
  async transcribe(pcm: Buffer, options: { names?: string[]; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<VoiceResult<{ text: string }>> {
    if (this.key() === null) return { ok: false, error: 'Add a Gemini key in Settings to talk.' }
    if (pcm.length === 0) return { ok: true, text: '' }
    if (pcm.length > MAX_DICTATION_BYTES) return { ok: false, error: 'That recording is too long. Keep it under five minutes.' }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? transcribeLimitMs(pcm.length))
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    try {
      return { ok: true, text: await transcribeAudio(this.gemini(), pcm, this.choice, { names: options.names ?? [], signal }) }
    } catch (error) {
      return { ok: false, error: explain(error) }
    }
  }

  hasKey(): boolean {
    return this.key() !== null
  }

  /** A voice note: the agent's own script said in `style`, saved as a WAV under notesDir. */
  async note(script: string, style: string): Promise<{ ok: true; file: string; durationMs: number } | { ok: false; error: string }> {
    if (this.key() === null) return { ok: false, error: 'Add a Gemini key in Settings to send voice notes.' }
    const dir = this.deps.notesDir
    if (dir === undefined) return { ok: false, error: 'Voice notes are not available in this build.' }
    try {
      // The first note of a session asks the key which speech models it has, newest first.
      if (!this.checked) await this.check()
      const { pcm } = await voiceNoteAudio(this.gemini(), script, this.deps.settings.get().voiceName || 'Kore', style, this.choice)
      mkdirSync(dir, { recursive: true })
      const file = `${this.now()}-${randomBytes(4).toString('hex')}.wav`
      writeFileSync(join(dir, file), wavOf(pcm))
      return { ok: true, file, durationMs: Math.round((pcm.length / 2 / OUTPUT_RATE) * 1000) }
    } catch (error) {
      return { ok: false, error: explain(error) }
    }
  }

  /** A saved note's audio, for the chat's player. Only plain note names: nothing outside notesDir. */
  noteAudio(file: string): Buffer | null {
    const dir = this.deps.notesDir
    if (dir === undefined || !/^[\w-]+\.wav$/.test(file)) return null
    try {
      return readFileSync(join(dir, file))
    } catch {
      return null
    }
  }

  async speak(text: string): Promise<VoiceResult<{ data: string }>> {
    if (this.key() === null) return { ok: false, error: 'Add a Gemini key in Settings to talk.' }
    try {
      const pcm = await speakText(this.gemini(), text, this.deps.settings.get().voiceName || 'Kore', this.choice)
      return { ok: true, data: pcm.toString('base64') }
    } catch (error) {
      return { ok: false, error: explain(error) }
    }
  }

  /**
   * A paired device with no Google key asks for a call: a one-use Live token from this computer's key, locked to
   * the Live model this key can reach. The key itself never leaves; the token cannot start a second call.
   */
  async liveToken(): Promise<LiveTokenResult> {
    if (this.key() === null) {
      return { ok: false, needsKey: true, error: 'Calls use the Google (Gemini) key on your computer. Add one there in Settings, Voice.' }
    }
    try {
      if (!this.checked) await this.check()
      const { token, expiresAt } = await mintLiveToken(this.gemini(), this.choice.live, this.now())
      return { ok: true, token, url: LIVE_TOKEN_URL, model: this.choice.live, voice: this.deps.settings.get().voiceName || 'Kore', expiresAt }
    } catch (error) {
      return { ok: false, needsKey: false, error: explain(error) }
    }
  }

  /** A call a paired device held with this agent: one compact call row in this chat, like a call held here. */
  async callSave(call: DeviceCall): Promise<{ itemId: string } | null> {
    if (call.lines.length === 0) return null
    const lines = call.lines.map((line, index) => ({ id: `d${index}`, who: line.who, text: line.text, at: line.at }))
    const row = await this.deps.store.upsert('chat_item', {
      kind: 'call',
      text: callText(lines.length, call.durationMs),
      createdAt: call.startedAt,
      meta: JSON.stringify({
        durationMs: call.durationMs,
        endedAt: call.startedAt + call.durationMs,
        lines: lines.map((line) => ({ who: line.who, text: line.text, at: line.at })),
        visuals: 0,
        handoffs: 0,
        device: true,
      }),
    })
    return { itemId: row.id }
  }

  // ---- the live call ---------------------------------------------------------------------

  get inCall(): boolean {
    return this.call !== null
  }

  async callStart(): Promise<{ ok: boolean; message: string }> {
    const key = this.key()
    if (key === null) return { ok: false, message: 'Add a Gemini key in Settings to talk.' }
    if (this.call !== null) return { ok: true, message: 'Already on a call.' }
    this.visuals = []
    this.handoffs = 0

    const tools = voiceTools({
      store: this.deps.store,
      handToAgent: (brief) => this.handToAgent(brief),
      show: (visual) => this.show(visual),
    })
    const session = new LiveSession({
      url: LIVE_URL,
      key,
      model: this.choice.live,
      voice: this.deps.settings.get().voiceName || 'Kore',
      systemPrompt: await this.callPrompt(),
      tools: tools.map((tool) => tool.spec),
      socket: this.deps.socket ?? nodeSocket,
      emit: (event) => this.deps.emit(event),
      runTool: async (name, args) => {
        const tool = tools.find((item) => item.spec.name === name)
        if (tool === undefined) return `There is no tool called ${name} on this call.`
        return tool.run(args, quietContext())
      },
      now: this.now,
    })
    this.call = session
    try {
      await session.start()
      return { ok: true, message: 'Connected.' }
    } catch (error) {
      this.call = null
      return { ok: false, message: error instanceof Error ? error.message : 'Could not connect the call.' }
    }
  }

  callAudio(pcm: Buffer): void {
    if (pcm.length > MAX_CHUNK_BYTES) return
    this.call?.audio(pcm)
  }

  callMute(muted: boolean): void {
    this.call?.mute(muted)
  }

  async callEnd(): Promise<CallSummary | null> {
    const session = this.call
    if (session === null) return null
    this.call = null
    session.end()
    const lines = session.lines
    const durationMs = Math.max(0, this.now() - session.startedAt)
    const said = lines.filter((line) => line.who !== 'note')
    const row = await this.deps.store.upsert('chat_item', {
      kind: 'call',
      text: callText(said.length, durationMs),
      createdAt: session.startedAt,
      meta: JSON.stringify({
        durationMs,
        endedAt: this.now(),
        lines: lines.map((line) => ({ who: line.who, text: line.text, at: line.at })),
        visuals: this.visuals.length,
        handoffs: this.handoffs,
      }),
    })
    this.deps.emit({ type: 'state', state: 'ended' })
    return { itemId: row.id, durationMs, lines: said.length }
  }

  private async handToAgent(brief: string): Promise<{ queued: boolean }> {
    const queued = this.deps.runner.state().running
    this.handoffs += 1
    this.call?.note(`Handed to your agent: ${brief.length > 120 ? `${brief.slice(0, 117)}...` : brief}`)
    // Not awaited: the run takes as long as it takes, and the call keeps talking meanwhile.
    void this.deps.runner.send(`From our voice call: ${brief}`).catch(() => undefined)
    return { queued }
  }

  private async show(input: Omit<CallVisual, 'id' | 'at'>): Promise<void> {
    const at = this.now()
    const row = await this.deps.store.upsert('chat_item', {
      kind: 'agent',
      text: visualMarkdown(input),
      meta: JSON.stringify({ from: 'call', visual: input }),
    })
    const visual: CallVisual = { ...input, id: row.id, at }
    this.visuals.push(visual)
    this.deps.emit({ type: 'visual', visual })
  }

  /** The main agent's own prompt, the recent chat, and how to behave on a call. */
  async callPrompt(): Promise<string> {
    const { store } = this.deps
    const settings = this.deps.settings.get()
    const [memories, goals, tasks, chat] = await Promise.all([
      store.list('memory'),
      store.list('goal'),
      store.list('task'),
      store.list('chat_item'),
    ])
    const recent = recentChat(chat)
    const base = buildSystemPrompt({
      settings,
      now: new Date(this.now()),
      platform: this.deps.platform ?? process.platform,
      memories,
      goals,
      tasks,
      latestUserText: recent.at(-1)?.text ?? '',
      role: 'main',
      environment: this.deps.environment?.() ?? null,
      ...(this.deps.timeZone === undefined ? {} : { timeZone: this.deps.timeZone }),
    })
    const name = settings.userName.trim() || 'the person'
    const lines = [
      base,
      '',
      '## This is a live voice call',
      `You are the same agent, speaking out loud with ${name} on a live call from their computer. Everything above still holds.`,
      'Talk like a person on the phone: short sentences, one or two at a time, warm and plain. No markdown, no lists read aloud, no urls spelled out.',
      'On this call your tools are hand_to_agent, show_on_screen, memory_search, memory_get, task_list and now. The other tools named above are the main agent\'s, not yours.',
      'Real work (research, writing, files, the browser, anything that takes more than a quick answer) goes to hand_to_agent with a full brief. Then say in a few words that it has started, and keep talking. Never pretend you did the work yourself.',
      'When something is easier to see than hear (steps, options, numbers, a picture, a key fact), call show_on_screen while you talk about it, and say the gist out loud too.',
      'If you need an answer from them, ask one clear question and wait.',
    ]
    if (recent.length > 0) {
      lines.push('', '## The chat just before this call')
      for (const item of recent) lines.push(`${item.kind === 'user' ? name : 'You'}: ${item.text.slice(0, 400)}`)
    }
    return lines.join('\n')
  }
}

function recentChat(items: ChatItem[]): ChatItem[] {
  return items
    .filter((item) => item.kind === 'user' || item.kind === 'agent')
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-RECENT_CHAT)
}

/** "Call, 3 min" in the chat; the row expands to the full transcript. */
export function callText(lines: number, durationMs: number): string {
  const minutes = Math.round(durationMs / 60_000)
  const length = minutes < 1 ? `${Math.max(1, Math.round(durationMs / 1000))} s` : `${minutes} min`
  return lines === 0 ? `Call, ${length}, nothing said` : `Call, ${length}`
}

/** Tools on a call run without chat activity rows or cards: the call view is where it shows. */
function quietContext(): ToolContext {
  return {
    agentLabel: 'voice',
    activity: async () => 0,
    updateActivity: async () => undefined,
    ask: async () => null,
    approve: async () => false,
    notify: async () => undefined,
    signal: new AbortController().signal,
  }
}

/** Node's own WebSocket (Node 22+, so Electron's main process has it). No dependency needed. */
const nodeSocket: SocketFactory = (url) => {
  const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => SocketLike }).WebSocket
  if (Ctor === undefined) throw new Error('This build has no WebSocket support.')
  return new Ctor(url)
}

