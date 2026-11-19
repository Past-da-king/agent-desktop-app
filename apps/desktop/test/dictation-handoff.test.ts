import { describe, expect, it } from 'vitest'

import type { DictationView } from '@agent/core'

import { DictationController, type DictationDeps } from '../src/main/dictation/controller'

const SECOND = 32_000
const loud = (seconds: number): Buffer => {
  const pcm = Buffer.alloc(seconds * SECOND)
  for (let i = 0; i < pcm.length / 2; i += 1) pcm.writeInt16LE(i % 2 === 0 ? 9000 : -9000, i * 2)
  return pcm
}

describe('instant send: the dictation hands its audio over', () => {
  it('ends at once with nothing typed and no pass of its own; the audio and the preview words go to the caller', () => {
    const typed: string[] = []
    const views: DictationView[] = []
    let batches = 0
    let handlers: { onUpdate: (text: string, interim: string) => void } | null = null
    const deps: DictationDeps = {
      hasKey: () => true,
      transcriber: (h) => {
        handlers = h
        return { start: () => Promise.resolve(), audio: () => undefined, finish: async () => '', flush: () => undefined, close: () => undefined, text: () => 'started edge letterhead' }
      },
      batch: async () => {
        batches += 1
        return { ok: true, text: 'whole' }
      },
      cleanUp: async (text) => text,
      type: async (text) => {
        typed.push(text)
        return 'inserted'
      },
      mask: () => undefined,
      pill: { show: () => undefined, hide: () => undefined, view: (view) => views.push(view), command: () => undefined },
      hold: () => () => undefined,
      keys: () => ({ dictate: 'Alt+Space', cleanSwitch: null }),
      format: (accelerator) => accelerator,
      previewFix: (text) => text.replace('started edge', 'Strat Edge'),
      log: () => undefined,
    }
    const controller = new DictationController(deps)
    expect(controller.handOff()).toBeNull()
    controller.toggle('plain')
    controller.micState(1, true, '')
    controller.audio(1, loud(3))
    handlers?.onUpdate('', '')
    const taken = controller.handOff()
    expect(taken).not.toBeNull()
    expect(taken?.pcm.length).toBe(3 * SECOND)
    expect(taken?.live).toBe('Strat Edge letterhead')
    expect(taken?.id).toMatch(/^d-/)
    expect(controller.phase).toBe('idle')
    expect(typed).toEqual([])
    expect(batches).toBe(0)
    expect(views.at(-1)?.phase).toBe('hidden')
    expect(controller.handOff()).toBeNull()
  })
})
