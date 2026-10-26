/**
 * Voice in the browser preview (?demo=1). No microphone, no network: a scripted call with growing
 * captions, one visual and one hand-off, so every voice screen can be clicked and screenshotted.
 */
import type { CallEvent, CallLine, CallVisual, ChatItem, Settings, Unsubscribe, VoiceApi } from '@agent/core'

export interface MockVoiceDeps {
  settings: () => Settings
  save: (patch: Partial<Settings>) => void
  insertChat: (item: Omit<ChatItem, 'id' | 'createdAt'> & { createdAt?: number }) => ChatItem
  send: (text: string) => Promise<void>
}

type Step = { after: number; run: () => void }

export function mockVoice(deps: MockVoiceDeps): VoiceApi {
  const listeners = new Set<(event: CallEvent) => void>()
  const emit = (event: CallEvent): void => {
    for (const listener of listeners) listener(event)
  }
  let key = ''
  let timers: ReturnType<typeof setTimeout>[] = []
  let startedAt = 0
  let lines: CallLine[] = []
  let live = false

  const clear = (): void => {
    for (const timer of timers) clearTimeout(timer)
    timers = []
  }

  const grow = (who: CallLine['who'], text: string, start: number, ms: number): Step[] => {
    const id = `mock-${who}-${start}`
    const words = text.split(' ')
    const steps: Step[] = words.map((_, index) => ({
      after: start + Math.round((ms / words.length) * (index + 1)),
      run: () => emit({ type: 'caption', line: { id, who, text: words.slice(0, index + 1).join(' '), at: Date.now() }, final: false }),
    }))
    steps.push({
      after: start + ms + 40,
      run: () => {
        const line = { id, who, text, at: Date.now() }
        lines.push(line)
        emit({ type: 'caption', line, final: true })
      },
    })
    return steps
  }

  const visual: Omit<CallVisual, 'id' | 'at'> = {
    kind: 'list',
    title: 'Due this week',
    items: ['Send the Thursday update', 'Book the venue for the 14th', 'Reply to the bank about the card'],
  }

  const script = (): Step[] => [
    { after: 500, run: () => emit({ type: 'state', state: 'listening' }) },
    ...grow('you', 'What is on my plate this week? And can you start the Thursday update?', 900, 1600),
    { after: 2700, run: () => emit({ type: 'state', state: 'thinking' }) },
    { after: 3100, run: () => emit({ type: 'state', state: 'speaking' }) },
    ...grow('agent', 'Three things are due. I have put them on screen.', 3100, 1500),
    {
      after: 3700,
      run: () => {
        const row = deps.insertChat({ kind: 'agent', text: markdown(visual), meta: JSON.stringify({ from: 'call', visual }) })
        emit({ type: 'visual', visual: { ...visual, id: row.id, at: Date.now() } })
      },
    },
    {
      after: 4900,
      run: () => {
        const line: CallLine = { id: 'mock-note', who: 'note', text: 'Started: Draft the Thursday update', at: Date.now() }
        lines.push(line)
        emit({ type: 'caption', line, final: true })
        void deps.send('From our voice call: Draft the Thursday update from this week\'s notes and tasks.')
      },
    },
    ...grow('agent', 'I have started the draft in the chat. Want me to book the venue too?', 5000, 1800),
    { after: 6900, run: () => emit({ type: 'state', state: 'waiting' }) },
  ]

  return {
    async setKey(value) {
      key = value.trim()
      deps.save({ hasVoiceKey: key !== '' })
    },
    async check() {
      await wait(500)
      if (!deps.settings().hasVoiceKey) return { ok: false, message: 'Add a Gemini key first.' }
      return { ok: true, message: 'That key works. Calls use gemini-3.8-live.' }
    },
    async transcribe() {
      await wait(500)
      if (!deps.settings().hasVoiceKey) return { ok: false, error: 'Add a Gemini key in Settings to talk.' }
      return { ok: true, text: 'Remind me to call the bank tomorrow morning about the new card.' }
    },
    async noteAudio() {
      // The preview's notes are a soft hum of the right length, so the player can be tried for real.
      const rate = 24_000
      const seconds = 14
      const pcm = new Int16Array(rate * seconds)
      for (let i = 0; i < pcm.length; i += 1) pcm[i] = Math.round(Math.sin((i / rate) * 2 * Math.PI * 196) * 1800 * Math.min(1, i / 2400, (pcm.length - i) / 2400))
      const out = new Uint8Array(44 + pcm.byteLength)
      const view = new DataView(out.buffer)
      const put = (at: number, text: string): void => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))
      put(0, 'RIFF'); view.setUint32(4, 36 + pcm.byteLength, true); put(8, 'WAVE'); put(12, 'fmt ')
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true)
      view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); put(36, 'data'); view.setUint32(40, pcm.byteLength, true)
      out.set(new Uint8Array(pcm.buffer), 44)
      return out
    },
    async speak() {
      await wait(300)
      if (!deps.settings().hasVoiceKey) return { ok: false, error: 'Add a Gemini key in Settings to talk.' }
      // Half a second of silence: the preview has nothing to say out loud, but the flow is real.
      return { ok: true, data: silence(0.5) }
    },
    async liveToken() {
      return { ok: false as const, needsKey: false, error: 'Calls from another device need a computer.' }
    },
    async callSave() {
      return null
    },
    async callTargets() {
      return []
    },
    async callHandoff() {
      return { ok: false as const, error: 'Calls from another device need a computer.', ambiguous: [] }
    },
    async callStart() {
      if (!deps.settings().hasVoiceKey) return { ok: false, message: 'Add a Gemini key in Settings to talk.' }
      clear()
      live = true
      startedAt = Date.now()
      lines = []
      emit({ type: 'state', state: 'connecting' })
      for (const step of script()) timers.push(setTimeout(step.run, step.after))
      return { ok: true, message: 'Connected.' }
    },
    callAudio() {
      // The preview has no call on the wire.
    },
    async callMute() {
      return undefined
    },
    async callEnd() {
      if (!live) return null
      live = false
      clear()
      const durationMs = Math.max(1000, Date.now() - startedAt)
      const row = deps.insertChat({
        kind: 'call',
        text: 'Call',
        createdAt: startedAt,
        meta: JSON.stringify({ durationMs, lines: lines.map(({ who, text, at }) => ({ who, text, at })) }),
      })
      emit({ type: 'state', state: 'ended' })
      return { itemId: row.id, durationMs, lines: lines.filter((line) => line.who !== 'note').length }
    },
    onCall(callback): Unsubscribe {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    // The preview keeps nothing on disk.
    async recordStart() {
      return null
    },
    async recordChunk() {
      return undefined
    },
    async recordEnd() {
      return undefined
    },
  }
}

function markdown(visual: Omit<CallVisual, 'id' | 'at'>): string {
  return [`**${visual.title}**`, '', ...(visual.items ?? []).map((item) => `- ${item}`)].join('\n')
}

function silence(seconds: number): string {
  const bytes = new Uint8Array(Math.round(24_000 * seconds) * 2)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index] ?? 0)
  return btoa(binary)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
