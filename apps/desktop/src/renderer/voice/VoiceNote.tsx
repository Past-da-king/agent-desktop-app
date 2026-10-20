import type { ChatItem } from '@agent/core'
import { useEffect, useMemo, useRef, useState } from 'react'

import { agent } from '../bridge'
import { parseMeta } from '../lib/meta'
import { Icon } from '../ui/Icon'
import { VoiceIcon } from './VoiceIcon'

const SPEEDS = [1, 1.5, 2] as const
/** One note plays at a time, like a messaging app. */
let playing: HTMLAudioElement | null = null

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A steady pseudo-wave from the note's id, so every note has its own shape and it never jumps. */
function bars(seed: string, count: number): number[] {
  let h = 2166136261
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return Array.from({ length: count }, (_, i) => {
    h = Math.imul(h ^ (i + 1), 2246822519) >>> 0
    return 0.28 + ((h % 1000) / 1000) * 0.72
  })
}

function scriptForReading(script: string): string {
  return script.replace(/<[a-z][a-z ]{1,24}>/gi, '').replace(/\s{2,}/g, ' ').trim()
}

/** A voice note from the agent: play, scrub along the wave, speed 1x / 1.5x / 2x, and the words underneath. */
export function VoiceNote({ item, agentName }: { item: ChatItem; agentName: string }): JSX.Element {
  const meta = parseMeta(item.meta)
  const file = typeof meta['file'] === 'string' ? meta['file'] : ''
  const given = typeof meta['durationMs'] === 'number' ? meta['durationMs'] : 0
  const audio = useRef<HTMLAudioElement | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'paused' | 'missing'>('idle')
  const [at, setAt] = useState(0)
  const [length, setLength] = useState(given)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1)
  const [words, setWords] = useState(false)
  const wave = useMemo(() => bars(item.id, 44), [item.id])

  useEffect(
    () => () => {
      const el = audio.current
      if (el !== null) {
        el.pause()
        if (el.src.startsWith('blob:')) URL.revokeObjectURL(el.src)
        if (playing === el) playing = null
      }
    },
    [],
  )

  const load = async (): Promise<HTMLAudioElement | null> => {
    if (audio.current !== null) return audio.current
    setState('loading')
    const bytes = file === '' ? null : await agent.voice.noteAudio(file).catch(() => null)
    if (bytes === null) {
      setState('missing')
      return null
    }
    const el = new Audio(URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/wav' })))
    el.playbackRate = speed
    el.addEventListener('timeupdate', () => setAt(el.currentTime * 1000))
    el.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(el.duration)) setLength(el.duration * 1000)
    })
    el.addEventListener('ended', () => {
      setState('paused')
      setAt(0)
      el.currentTime = 0
    })
    el.addEventListener('pause', () => setState((s) => (s === 'playing' ? 'paused' : s)))
    audio.current = el
    return el
  }

  const toggle = async (): Promise<void> => {
    const el = await load()
    if (el === null) return
    if (!el.paused) {
      el.pause()
      return
    }
    if (playing !== null && playing !== el) playing.pause()
    playing = el
    el.playbackRate = speed
    try {
      await el.play()
      setState('playing')
    } catch {
      setState('missing')
    }
  }

  const seek = async (fraction: number): Promise<void> => {
    const el = await load()
    if (el === null || length <= 0) return
    el.currentTime = (fraction * length) / 1000
    setAt(fraction * length)
  }

  const nextSpeed = (): void => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1
    setSpeed(next)
    if (audio.current !== null) audio.current.playbackRate = next
  }

  const done = length > 0 ? Math.min(1, at / length) : 0
  const live = state === 'playing'

  return (
    <div className="vnote-wrap">
      <div className={`vnote${live ? ' live' : ''}`} role="group" aria-label={`Voice note from ${agentName}, ${clock(length)}`}>
        <button
          type="button"
          className="vnote-play"
          onClick={() => void toggle()}
          disabled={state === 'missing'}
          aria-label={live ? 'Pause the voice note' : 'Play the voice note'}
        >
          {state === 'loading' ? <span className="vnote-spin" /> : <Icon name={live ? 'pause' : 'play'} size={22} />}
        </button>
        <div
          className="vnote-wave"
          role="slider"
          tabIndex={0}
          aria-label="Position in the voice note"
          aria-valuemin={0}
          aria-valuemax={Math.round(length / 1000)}
          aria-valuenow={Math.round(at / 1000)}
          onPointerDown={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            void seek(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)))
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') void seek(Math.min(1, done + 0.05))
            if (event.key === 'ArrowLeft') void seek(Math.max(0, done - 0.05))
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault()
              void toggle()
            }
          }}
        >
          {wave.map((h, i) => (
            <i key={i} className={i / wave.length < done ? 'on' : ''} style={{ height: `${Math.round(h * 100)}%` }} />
          ))}
        </div>
        <span className="vnote-time">{state === 'missing' ? 'Not on this computer' : clock(live || at > 0 ? at : length)}</span>
        <button type="button" className="vnote-speed" onClick={nextSpeed} aria-label={`Speed ${speed} times, change`}>
          {speed}x
        </button>
      </div>
      <button type="button" className="vnote-words" aria-expanded={words} onClick={() => setWords((v) => !v)}>
        <VoiceIcon name="speaker" size={14} />
        {words ? 'Hide the words' : 'Show the words'}
      </button>
      {words ? <p className="vnote-script">{scriptForReading(item.text)}</p> : null}
    </div>
  )
}
