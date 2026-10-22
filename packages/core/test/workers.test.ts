import { describe, expect, it } from 'vitest'

import {
  WORKER_PAYLOAD_MAX,
  describeEventFilter,
  matchesEvent,
  normaliseManifest,
  parseEventFilter,
  parseWorkerLine,
  payloadText,
} from '../src/workers'

describe('parseWorkerLine', () => {
  it('reads every kind of contract line', () => {
    expect(parseWorkerLine('{"type":"ready"}')).toEqual({ type: 'ready' })
    expect(parseWorkerLine('{"type":"alive"}')).toEqual({ type: 'alive' })
    expect(parseWorkerLine('{"type":"cursor","value":42}')).toEqual({ type: 'cursor', value: '42' })
    expect(parseWorkerLine('{"type":"log","level":"warn","text":"slow"}')).toEqual({ type: 'log', level: 'warn', text: 'slow' })
    expect(parseWorkerLine('{"type":"event","source":"chat","event":"message.dm","payload":{"text":"hi"},"dedupeKey":"D1/1","seenAt":5}')).toEqual({
      type: 'event',
      event: { source: 'chat', event: 'message.dm', payload: { text: 'hi' }, dedupeKey: 'D1/1', seenAt: 5 },
    })
  })

  it('never throws: anything else becomes a log line, and a bad event says why', () => {
    expect(parseWorkerLine('')).toBeNull()
    expect(parseWorkerLine('connected to the socket')).toEqual({ type: 'log', level: 'info', text: 'connected to the socket' })
    expect(parseWorkerLine('{not json')).toEqual({ type: 'log', level: 'info', text: '{not json' })
    const noKey = parseWorkerLine('{"type":"event","source":"chat","event":"x","payload":{}}')
    expect(noKey).toEqual({ type: 'log', level: 'warn', text: 'Event ignored: it needs a dedupeKey' })
    const noSource = parseWorkerLine('{"type":"event","event":"x","dedupeKey":"1"}')
    expect(noSource?.type).toBe('log')
  })

  it('cuts a payload that is too big and marks it', () => {
    const big = payloadText({ text: 'x'.repeat(WORKER_PAYLOAD_MAX * 2) })
    expect(big.length).toBeLessThanOrEqual(WORKER_PAYLOAD_MAX)
    expect(JSON.parse(big)._cut).toBe(true)
  })
})

describe('event filters', () => {
  const event = { worker: 'w_ab12', source: 'chat', event: 'message.dm', payload: JSON.stringify({ channel: { name: 'Sales' }, text: 'Invoice please' }) }

  it('needs a worker or a source, so a routine never takes every event', () => {
    expect(parseEventFilter('{"event":"*"}')).toMatch(/worker or a source/)
    expect(parseEventFilter('nope')).toMatch(/JSON/)
    expect(parseEventFilter('{"worker":"w_ab12"}')).toEqual({ worker: 'w_ab12' })
  })

  it('matches worker, source, wildcard event names and payload text', () => {
    const f = (spec: string): boolean => {
      const filter = parseEventFilter(spec)
      if (typeof filter === 'string') throw new Error(filter)
      return matchesEvent(filter, event)
    }
    expect(f('{"worker":"w_ab12"}')).toBe(true)
    expect(f('{"worker":"w_zz99"}')).toBe(false)
    expect(f('{"source":"CHAT","event":"message.*"}')).toBe(true)
    expect(f('{"source":"chat","event":"mail.*"}')).toBe(false)
    expect(f('{"worker":"w_ab12","match":{"channel.name":"sales","text":"invoice"}}')).toBe(true)
    expect(f('{"worker":"w_ab12","match":{"text":"refund"}}')).toBe(false)
  })

  it('reads back in plain words', () => {
    expect(describeEventFilter('{"worker":"w_ab12","event":"message.*"}', () => 'Team chat')).toBe('When Team chat sends message.*')
  })
})

describe('manifests', () => {
  it('keeps the entry inside the folder and secrets in capitals', () => {
    expect(normaliseManifest({ name: 'x', entry: '../evil.mjs' }, 'w_ab12')).toMatch(/inside the worker folder/)
    expect(normaliseManifest({ name: 'x', entry: 'main.mjs', secrets: ['token'] }, 'w_ab12')).toMatch(/CAPITALS/)
    expect(normaliseManifest({ name: 'x', entry: 'main.mjs', mode: 'every' }, 'w_ab12')).toMatch(/everyMinutes/)
    const ok = normaliseManifest({ name: 'Chat', entry: 'main.mjs', secrets: ['CHAT_TOKEN'] }, 'w_ab12')
    expect(typeof ok).toBe('object')
    if (typeof ok !== 'string') {
      expect(ok.runtime).toBe('node')
      expect(ok.mode).toBe('stay')
      expect(ok.enabled).toBe(true)
    }
  })
})
