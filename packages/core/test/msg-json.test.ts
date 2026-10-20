import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  msgFromJson,
  msgText,
  msgToJson,
  msgToolCalls,
  userMsg,
  type Msg,
} from '../src/model'

describe('message JSON', () => {
  it('round trips every block type', () => {
    const msg: Msg = {
      role: 'ASSISTANT',
      blocks: [
        { t: 'text', text: 'Let me check.' },
        {
          t: 'call',
          id: 'call_1',
          name: 'now',
          input: { zone: 'UTC' },
          extra: { google: { thought_signature: 'sig' } },
        },
        { t: 'result', id: 'call_1', content: 'noon', err: false },
        { t: 'reasoning', text: 'thinking it over' },
        { t: 'image', path: '/tmp/photo.jpg', mime: 'image/png' },
      ],
    }

    expect(msgFromJson(msgToJson(msg))).toEqual(msg)
  })

  it('parses a Kotlin-shaped fixture into the same blocks', () => {
    const fixture = {
      role: 'ASSISTANT',
      blocks: [
        { t: 'text', text: 'Let me check.' },
        {
          t: 'call',
          id: 'toolu_1',
          name: 'now',
          input: { zone: 'UTC' },
          extra: { google: { thought_signature: 'sig' } },
        },
        { t: 'reasoning', text: 'thinking it over' },
        { t: 'image', path: '/tmp/photo.jpg', mime: 'image/png' },
        { t: 'result', id: 'toolu_1', content: 'noon', err: true },
      ],
    }

    const msg = msgFromJson(fixture)

    expect(msg.role).toBe('ASSISTANT')
    expect(msg.blocks).toEqual([
      { t: 'text', text: 'Let me check.' },
      {
        t: 'call',
        id: 'toolu_1',
        name: 'now',
        input: { zone: 'UTC' },
        extra: { google: { thought_signature: 'sig' } },
      },
      { t: 'reasoning', text: 'thinking it over' },
      { t: 'image', path: '/tmp/photo.jpg', mime: 'image/png' },
      { t: 'result', id: 'toolu_1', content: 'noon', err: true },
    ])
  })

  it('defaults a missing image mime and a missing result err', () => {
    const msg = msgFromJson({
      role: 'USER',
      blocks: [
        { t: 'image', path: '/tmp/photo.jpg' },
        { t: 'result', id: 'c1', content: 'ok' },
        { t: 'unknown', text: 'treated as text' },
      ],
    })

    expect(msg.blocks).toEqual([
      { t: 'image', path: '/tmp/photo.jpg', mime: 'image/jpeg' },
      { t: 'result', id: 'c1', content: 'ok', err: false },
      { t: 'text', text: 'treated as text' },
    ])
  })

  it('userMsg filters images that are not on disk and puts the text last', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-msg-'))
    const file = join(dir, 'photo.jpg')
    writeFileSync(file, 'abc')
    try {
      const msg = userMsg('look', [file, join(dir, 'missing.jpg')])
      expect(msg.blocks).toEqual([
        { t: 'image', path: file, mime: 'image/jpeg' },
        { t: 'text', text: 'look' },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('joins text blocks and lists tool calls', () => {
    const msg: Msg = {
      role: 'ASSISTANT',
      blocks: [
        { t: 'text', text: ' first ' },
        { t: 'call', id: 'c1', name: 'now', input: {} },
        { t: 'text', text: 'second' },
      ],
    }

    expect(msgText(msg)).toBe('first \nsecond')
    expect(msgToolCalls(msg)).toEqual([{ t: 'call', id: 'c1', name: 'now', input: {} }])
  })
})
