/** A chat is filed even when the model's JSON is not quite JSON (the "Could not save the last chat to memory" bug). */
import { describe, expect, it } from 'vitest'

import { replyObject } from '../src/main/memory/reply-json'
import { parseDigest } from '../src/main/memory/summarise'

describe('reading the model reply', () => {
  it('takes real line breaks inside a string (a numbered how-to)', () => {
    const reply = '{"title": "Deploy", "summary": "How to deploy.", "memories": [{"kind": "how-to", "title": "Deploy the site", "body": "1. Build\n2. Push\n3. Check", "topics": "deploy", "update": ""}]}'
    const digest = parseDigest(reply)
    expect(digest.entries[0]?.body).toBe('1. Build\n2. Push\n3. Check')
  })

  it('keeps the entries written before a reply was cut off', () => {
    const reply = '{"title": "Trip", "summary": "Planned Lisbon.", "memories": [{"kind": "decision", "title": "Lisbon in March", "body": "Going in March.", "topics": "travel", "update": ""}, {"kind": "fact", "title": "Hotel", "body": "The hotel is near the riv'
    const digest = parseDigest(reply)
    expect(digest.title).toBe('Trip')
    expect(digest.entries.map((e) => e.title)).toEqual(['Lisbon in March', 'Hotel'])
  })

  it('reads past a think block, a code fence, prose and trailing commas', () => {
    const reply = '<think>maybe {"x": 1}</think>Here you go:\n```json\n{"title": "A", "summary": "B", "memories": [],}\n```\nDone.'
    expect(parseDigest(reply)).toEqual({ title: 'A', summary: 'B', entries: [] })
  })

  it('says plainly when there is no JSON at all', () => {
    expect(() => parseDigest('Sorry, I cannot help with that.')).toThrow('did not reply with a summary')
    expect(replyObject('[1, 2]')).toBeNull()
  })
})
