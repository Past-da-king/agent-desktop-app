/**
 * Instant send's computer side, wired the same for the Electron app (main/index.ts) and the headless node
 * (headless/runtime.ts): the durable take queue (pending.ts), the runner's hold on the agent's turn, the voice.takeAudio
 * handler a paired phone calls, and the resume at start. No Electron here.
 */
import { join } from 'node:path'

import type { VoiceTakeAck, VoiceTakeInput } from '@agent/core'

import type { BatchResult } from './controller'
import { PendingTakes } from './pending'

/** The runner's half (runtime/runner.ts). */
export interface InstantRunner {
  setTakes(takes: PendingTakes): void
  refineDictated(take: string, text: string, clean: boolean, chat?: string | null): Promise<void>
  markRefining(take: string, chat?: string | null): Promise<void>
}

export interface InstantSendDeps {
  /** The data folder; takes are queued under `<dir>/voice-notes/pending-takes`. */
  dir: string
  /** The whole-audio pass (take-batch.ts, or the Electron dictation's own). */
  batch: (pcm: Buffer, signal: AbortSignal, extra?: { names?: string[]; languages?: string[] }) => Promise<BatchResult>
  runner: () => InstantRunner | null
  log: (message: string, fields?: Record<string, string | number | boolean>) => void
  /** Where the callers leave what to do with a take's text; one is made when none is given. */
  takeFinals?: Map<string, (text: string) => void>
}

export interface InstantSend {
  queue: PendingTakes
  /** What to do with the whole-take text when it lands (the kept recording's transcript), by take id. */
  takeFinals: Map<string, (text: string) => void>
  /** The voice.takeAudio handler. */
  takeAudio(input: VoiceTakeInput): Promise<VoiceTakeAck>
  /** Runs every take the last run left queued or running. */
  resume(): Promise<number>
}

export function createInstantSend(deps: InstantSendDeps): InstantSend {
  const takeFinals = deps.takeFinals ?? new Map<string, (text: string) => void>()
  const queue = new PendingTakes({
    dir: join(deps.dir, 'voice-notes', 'pending-takes'),
    batch: (pcm, signal, extra) => deps.batch(pcm, signal, extra),
    replace: async (take, text) => {
      await deps.runner()?.refineDictated(take.id, text, true, take.chat)
      takeFinals.get(take.id)?.(text)
      takeFinals.delete(take.id)
    },
    retrying: (take) => deps.runner()?.markRefining(take.id, take.chat),
    retryFailed: (take) => deps.runner()?.refineDictated(take.id, '', false, take.chat),
    log: deps.log,
  })
  deps.runner()?.setTakes(queue)
  return {
    queue,
    takeFinals,
    takeAudio: async (input) => {
      // The phone's half: its message is already in the chat; this is the audio for it, by recording id.
      if (input.audio === undefined) {
        if (input.retry !== true) return { ok: false, error: 'The take has no audio.' }
        const ok = await queue.retry(input.id)
        return { ok, state: ok ? 'queued' : ((await queue.state(input.id))?.state ?? 'unknown') }
      }
      const result = await queue.accept({
        id: input.id,
        chat: input.chat ?? null,
        live: input.caption ?? '',
        pcm: Buffer.from(input.audio),
        ...(input.names === undefined ? {} : { names: input.names }),
        ...(input.languages === undefined ? {} : { languages: input.languages }),
      })
      return { ok: true, state: result.state, duplicate: result.duplicate }
    },
    resume: () => queue.resume(),
  }
}
