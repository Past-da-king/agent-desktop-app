/**
 * The Gemini REST side of voice: the key check, dictation (one generateContent with the audio) and
 * read-aloud (TTS). Main process only: the key never leaves this file's callers.
 *
 * Model ids drift, so every job has an ordered list and the first one the key can reach wins. The
 * check lists the models the key can see and remembers the best of each list for this session.
 */
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com'
export const LIVE_URL = `${GEMINI_BASE.replace('https://', 'wss://')}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`

/** Native-audio Live models, newest first. Older 2.0/2.5 live previews are no longer served. */
export const LIVE_MODELS = ['gemini-3.8-live', 'gemini-3.1-flash-live-preview', 'gemini-2.5-flash-native-audio-preview-09-2025']
export const TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts']
export const TRANSCRIBE_MODELS = ['gemini-3.5-flash-lite', 'gemini-2.5-flash']

export const INPUT_RATE = 16_000
export const OUTPUT_RATE = 24_000
const MAX_TTS_CHARS = 4_000

export interface GeminiDeps {
  key: () => string | null
  fetchImpl?: typeof fetch
}

/** The models the check found, so later calls skip ids that would 404. */
export interface ModelChoice {
  live: string
  tts: string
  transcribe: string
}

export const DEFAULT_CHOICE: ModelChoice = {
  live: LIVE_MODELS[0] ?? '',
  tts: TTS_MODELS[0] ?? '',
  transcribe: TRANSCRIBE_MODELS[0] ?? '',
}

export class GeminiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Plain words for a failed call. Never echoes the key or the raw body. */
export function explain(error: unknown): string {
  if (error instanceof GeminiError) {
    if (error.status === 400 && /api key/i.test(error.message)) return 'That Gemini key was not accepted.'
    if (error.status === 401 || error.status === 403) return 'That Gemini key was not accepted.'
    if (error.status === 429) return 'Gemini says this key is out of quota for now. Try again later.'
    if (error.status === 0) return 'Could not reach Gemini. Check the connection.'
    return `Gemini could not do that (${error.status}).`
  }
  return 'Could not reach Gemini. Check the connection.'
}

async function post(deps: GeminiDeps, model: string, body: unknown): Promise<Record<string, unknown>> {
  const key = deps.key()
  if (key === null || key.trim() === '') throw new GeminiError(401, 'No key')
  const fetcher = deps.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetcher(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key.trim() },
      body: JSON.stringify(body),
    })
  } catch {
    throw new GeminiError(0, 'unreachable')
  }
  const text = await response.text()
  if (!response.ok) throw new GeminiError(response.status, errorMessage(text))
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new GeminiError(502, 'Unreadable reply')
  }
}

function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } }
    const message = parsed.error?.message
    return typeof message === 'string' ? message.slice(0, 200) : 'error'
  } catch {
    return 'error'
  }
}

/** Tries each model in turn; a 404 moves on, anything else stops. */
async function firstThatAnswers<T>(models: string[], run: (model: string) => Promise<T>): Promise<T> {
  let last: unknown = new GeminiError(404, 'No model')
  for (const model of models) {
    try {
      return await run(model)
    } catch (error) {
      last = error
      if (!(error instanceof GeminiError) || error.status !== 404) throw error
    }
  }
  throw last
}

function preferring(choice: string, list: string[]): string[] {
  return choice === '' ? list : [choice, ...list.filter((model) => model !== choice)]
}

function version(model: string): number {
  const match = /gemini-(\d+(?:\.\d+)?)/.exec(model)
  return match === null ? 0 : Number(match[1])
}

/** Newest first; a stable model before a preview of the same version. */
function newest(models: string[]): string[] {
  return [...models].sort((a, b) => version(b) - version(a) || Number(/preview|exp/.test(a)) - Number(/preview|exp/.test(b)) || a.localeCompare(b))
}

/**
 * Pick each job's model from what this key actually lists, by what the model does (live audio, speech,
 * text), newest first. New Gemini models are used the day the key can see them; the fixed lists are only
 * the fallback when the key lists nothing that fits.
 */
export function chooseModels(listed: string[]): ModelChoice {
  const live = newest(listed.filter((m) => /live|native-audio/.test(m) && !/tts/.test(m)))
  const tts = newest(listed.filter((m) => /tts/.test(m)))
  const text = newest(listed.filter((m) => /^gemini-[\d.]+-flash(-lite)?(-preview[\w-]*)?$/.test(m)))
  // Transcription wants the quick one: a lite model when there is one of the newest version.
  const top = text[0] === undefined ? 0 : version(text[0])
  const transcribe = text.find((m) => version(m) === top && /lite/.test(m)) ?? text[0]
  const has = new Set(listed)
  const fallback = (list: string[]): string => list.find((m) => has.has(m)) ?? list[0] ?? ''
  return {
    live: live[0] ?? fallback(LIVE_MODELS),
    tts: tts[0] ?? fallback(TTS_MODELS),
    transcribe: transcribe ?? fallback(TRANSCRIBE_MODELS),
  }
}

/** The check: list the models the key can see (one cheap, real call) and pick the best of each list. */
export async function checkKey(deps: GeminiDeps): Promise<{ ok: boolean; message: string; choice?: ModelChoice }> {
  const key = deps.key()
  if (key === null || key.trim() === '') return { ok: false, message: 'Add a Gemini key first.' }
  const fetcher = deps.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetcher(`${GEMINI_BASE}/v1beta/models?pageSize=1000`, {
      headers: { 'x-goog-api-key': key.trim() },
    })
  } catch {
    return { ok: false, message: 'Could not reach Gemini. Check the connection.' }
  }
  if (!response.ok) {
    return { ok: false, message: explain(new GeminiError(response.status, errorMessage(await response.text()))) }
  }
  const body = (await response.json().catch(() => ({}))) as { models?: Array<{ name?: unknown }> }
  const names = new Set(
    (body.models ?? []).flatMap((model) =>
      typeof model.name === 'string' ? [model.name.replace(/^models\//, '')] : [],
    ),
  )
  const choice = chooseModels([...names])
  return { ok: true, message: `That key works. Calls use ${choice.live}.`, choice }
}

function inlineAudio(body: Record<string, unknown>): string | null {
  const candidates = body['candidates']
  if (!Array.isArray(candidates)) return null
  const first = candidates[0] as { content?: { parts?: Array<{ inlineData?: { data?: unknown } }> } } | undefined
  for (const part of first?.content?.parts ?? []) {
    if (typeof part.inlineData?.data === 'string') return part.inlineData.data
  }
  return null
}

function textOf(body: Record<string, unknown>): string {
  const candidates = body['candidates']
  if (!Array.isArray(candidates)) return ''
  const first = candidates[0] as { content?: { parts?: Array<{ text?: unknown }> } } | undefined
  return (first?.content?.parts ?? [])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim()
}

/** Read text aloud. Returns raw 24 kHz PCM16 (a WAV header, when Gemini sends one, is stripped). */
export async function speak(deps: GeminiDeps, text: string, voice: string, choice: ModelChoice): Promise<Buffer> {
  const clean = plainForSpeech(text).slice(0, MAX_TTS_CHARS)
  if (clean === '') throw new GeminiError(400, 'Nothing to read')
  return firstThatAnswers(preferring(choice.tts, TTS_MODELS), async (model) => {
    const body = await post(deps, model, {
      contents: [{ role: 'user', parts: [{ text: clean }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    })
    const data = inlineAudio(body)
    if (data === null) throw new GeminiError(502, 'No audio came back')
    return stripWav(Buffer.from(data, 'base64'))
  })
}

/** Dictation: the whole recording in one call, transcribed word for word. */
export async function transcribe(deps: GeminiDeps, pcm: Buffer, choice: ModelChoice): Promise<string> {
  const wav = wavFromPcm(pcm, INPUT_RATE)
  return firstThatAnswers(preferring(choice.transcribe, TRANSCRIBE_MODELS), async (model) => {
    const body = await post(deps, model, {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                'Transcribe this voice note exactly as spoken, in the language spoken. Add normal punctuation. ' +
                'Reply with the transcript only. If nobody speaks, reply with nothing.',
            },
            { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } },
          ],
        },
      ],
      generationConfig: { temperature: 0 },
    })
    return textOf(body)
  })
}

/** Markdown out, so the voice does not read asterisks and link targets. */
export function plainForSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export function wavFromPcm(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Some TTS models answer with a WAV file, some with bare L16. The renderer wants bare PCM. */
export function stripWav(bytes: Buffer): Buffer {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') return bytes
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    if (id === 'data') return bytes.subarray(offset + 8, Math.min(bytes.length, offset + 8 + size))
    offset += 8 + size
  }
  return bytes.subarray(44)
}
