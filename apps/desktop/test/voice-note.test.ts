/** Voice notes done properly: the agent's own script, the style as speech metadata, tags never read out. */
import { describe, expect, it } from 'vitest'

import { DEFAULT_CHOICE, stripTags, voiceNoteAudio, wavOf } from '../src/main/voice/gemini'

const pcm = Buffer.alloc(4800, 1)

describe('voice notes', () => {
  it('sends the script with the style as speech metadata to the Interactions API', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: pcm.toString('base64') }] }] }), { status: 200 })
    }) as unknown as typeof fetch
    const out = await voiceNoteAudio({ key: () => 'k', fetchImpl }, 'Hey Sam. <short pause> It is DONE.', 'Kore', 'upbeat, quick', DEFAULT_CHOICE)
    expect(out.pcm.length).toBe(pcm.length)
    expect(calls[0]?.url).toContain('/v1beta/interactions')
    const input = (calls[0]?.body['input'] as Array<{ content: Array<{ text: string; annotations: unknown[] }> }>)[0]?.content[0]
    expect(input?.text).toBe('Hey Sam. <short pause> It is DONE.')
    expect(input?.annotations).toEqual([{ type: 'speech_metadata', style: 'upbeat, quick' }])
  })

  it('falls back to generateContent with the tags stripped when a model does not take that request', async () => {
    const urls: string[] = []
    let plain = ''
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urls.push(url)
      if (url.includes('/interactions')) return new Response('{}', { status: 400 })
      plain = (JSON.parse(String(init?.body)) as { contents: Array<{ parts: Array<{ text: string }> }> }).contents[0]?.parts[0]?.text ?? ''
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: pcm.toString('base64') } }] } }] }), { status: 200 })
    }) as unknown as typeof fetch
    await voiceNoteAudio({ key: () => 'k', fetchImpl }, 'Right. <laugh> That worked.', 'Kore', '', DEFAULT_CHOICE)
    expect(urls.some((u) => u.includes(':generateContent'))).toBe(true)
    expect(plain).toBe('Right. That worked.')
  })

  it('a model out of quota hands over to the next speech model', async () => {
    const models: string[] = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model?: string }
      models.push(body.model ?? '')
      if (models.length === 1) return new Response('{"error":{"message":"quota"}}', { status: 429 })
      return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: pcm.toString('base64') }] }] }), { status: 200 })
    }) as unknown as typeof fetch
    const out = await voiceNoteAudio({ key: () => 'k', fetchImpl }, 'Hello.', 'Kore', '', { ...DEFAULT_CHOICE, speech: ['tts-a', 'tts-b'], tts: 'tts-a' })
    expect(out.model).toBe('tts-b')
  })

  it('wraps PCM in a WAV header and strips tags for reading', () => {
    const wav = wavOf(pcm)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(40)).toBe(pcm.length)
    expect(stripTags('One <short pause> two')).toBe('One two')
  })
})
