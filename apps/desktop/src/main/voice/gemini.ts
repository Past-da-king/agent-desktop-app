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
  /** Every speech model the key lists, newest first: each has its own quota, so a note can move along them. */
  speech?: string[]
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
    if (error.status === -1) return error.message === 'cancelled' ? 'Cancelled.' : 'Gemini took too long to answer.'
    if (error.status === 503) return 'Gemini is busy right now. Try again in a moment.'
    return `Gemini could not do that (${error.status}).`
  }
  return 'Could not reach Gemini. Check the connection.'
}

async function post(deps: GeminiDeps, model: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const key = deps.key()
  if (key === null || key.trim() === '') throw new GeminiError(401, 'No key')
  const fetcher = deps.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetcher(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key.trim() },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    if (signal?.aborted === true) throw new GeminiError(-1, signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'timeout' : 'cancelled')
    throw new GeminiError(0, error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unreachable')
  }
  let text: string
  try {
    text = await response.text()
  } catch {
    throw new GeminiError(signal?.aborted === true ? -1 : 0, 'unreachable')
  }
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

/** Like firstThatAnswers, moving on for each status in `skip`. */
async function eachModel<T>(models: string[], skip: number[], run: (model: string) => Promise<T>): Promise<T> {
  let last: unknown = new GeminiError(404, 'No model')
  for (const model of models) {
    try {
      return await run(model)
    } catch (error) {
      last = error
      if (!(error instanceof GeminiError) || !skip.includes(error.status)) throw error
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
    speech: tts.length > 0 ? tts : TTS_MODELS,
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

/** Vocal tags such as <short pause> or <laugh>: performed by newer speech models, spoken aloud by older ones. */
export function stripTags(script: string): string {
  return script.replace(/<[a-z][a-z ]{1,24}>/gi, ' ').replace(/\s{2,}/g, ' ').trim()
}

/** A voice note is at most about four minutes: the voice speaks roughly eleven characters a second. */
export const MAX_NOTE_CHARS = 2_800

/**
 * A voice note: the agent's own spoken script, said in `style` (a delivery direction such as "warm, unhurried"
 * that is applied, never spoken). It goes through the Interactions API first, where speech models perform
 * vocal tags and take the style as speech metadata. A model that does not take that request gets the plain
 * script through generateContent, tags stripped, so nothing like "<laugh>" is ever read out.
 * Returns raw 24 kHz mono PCM16.
 */
export async function voiceNoteAudio(
  deps: GeminiDeps,
  script: string,
  voice: string,
  style: string,
  choice: ModelChoice,
): Promise<{ pcm: Buffer; model: string }> {
  const said = script.trim().slice(0, MAX_NOTE_CHARS)
  if (said === '') throw new GeminiError(400, 'Nothing to say')
  const key = deps.key()
  if (key === null || key.trim() === '') throw new GeminiError(401, 'No key')
  const fetcher = deps.fetchImpl ?? fetch
  // Each speech model has its own daily quota, so a model that is out of quota hands over to the next one.
  return eachModel(preferring(choice.tts, choice.speech ?? TTS_MODELS), [404, 429], async (model) => {
    let response: Response | null = null
    try {
      response = await fetcher(`${GEMINI_BASE}/v1beta/interactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key.trim() },
        body: JSON.stringify({
          model,
          input: [
            {
              type: 'user_input',
              content: [{ type: 'text', text: said, ...(style.trim() === '' ? {} : { annotations: [{ type: 'speech_metadata', style: style.trim().slice(0, 300) }] }) }],
            },
          ],
          response_format: { type: 'audio' },
          generation_config: { speech_config: [{ voice }] },
        }),
        signal: AbortSignal.timeout(240_000),
      })
    } catch {
      response = null
    }
    if (response !== null && response.ok) {
      const body = (await response.json().catch(() => ({}))) as { steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: string }> }> }
      const audio = (body.steps ?? [])
        .filter((step) => step.type === 'model_output')
        .flatMap((step) => step.content ?? [])
        .filter((part) => part.type === 'audio' && typeof part.data === 'string')
        .pop()
      if (audio?.data !== undefined) return { pcm: stripWav(Buffer.from(audio.data, 'base64')), model }
    }
    if (response !== null && (response.status === 401 || response.status === 403 || response.status === 429)) {
      throw new GeminiError(response.status, errorMessage(await response.text().catch(() => '')))
    }
    // This model does not take the Interactions request: the plain script, with no tags to read out.
    const body = await post(deps, model, {
      contents: [{ role: 'user', parts: [{ text: stripTags(said) }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    })
    const data = inlineAudio(body)
    if (data === null) throw new GeminiError(502, 'No audio came back')
    return { pcm: stripWav(Buffer.from(data, 'base64')), model }
  })
}

/** 24 kHz mono PCM16 in a WAV container, which every player opens. */
export function wavOf(pcm: Buffer, rate = OUTPUT_RATE): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * Dictation: the whole recording in one call, transcribed word for word. `names` are the people, companies and
 * projects the speaker talks about, so they come back spelled right. `signal` bounds it: a call that never
 * answers must never leave a dictation waiting.
 */
export async function transcribe(
  deps: GeminiDeps,
  pcm: Buffer,
  choice: ModelChoice,
  options: { names?: string[]; signal?: AbortSignal } = {},
): Promise<string> {
  const wav = wavFromPcm(pcm, INPUT_RATE)
  const names = (options.names ?? []).filter((name) => name.trim() !== '').slice(0, 100)
  const hint = names.length === 0 ? '' : ` Names the speaker may say, spelled as they should be written: ${names.join(', ')}.`
  // A busy model (503) or one out of quota (429) hands over to the next one, like a missing one (404).
  return eachModel(preferring(choice.transcribe, TRANSCRIBE_MODELS), [404, 429, 503], async (model) => {
    const body = await post(
      deps,
      model,
      {
        contents: [
          {
            role: 'user',
            parts: [
              {
                text:
                  'Transcribe this voice note exactly as spoken, in the language spoken. Add normal punctuation. ' +
                  'Reply with the transcript only. If nobody speaks, reply with nothing.' +
                  hint,
              },
              { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } },
            ],
          },
        ],
        generationConfig: { temperature: 0 },
      },
      options.signal,
    )
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

/**
 * Where a device with no key of its own opens a Live call: the constrained endpoint takes a short-lived token
 * (`access_token=`) instead of the key. Verified against Google 22 Oct 2026: the plain endpoint refuses tokens.
 */
export const LIVE_TOKEN_URL = `${LIVE_URL}Constrained`

/** A token lasts this long; Google resumes a call on the same token within it. */
export const LIVE_TOKEN_TTL_MS = 30 * 60_000
/** And a new call must start within this. */
export const LIVE_TOKEN_START_MS = 2 * 60_000

/**
 * A one-use Gemini Live token (auth_tokens, uses 1), locked to `model`, for a paired device that has no key of its
 * own. The key stays here; the token cannot list models, call any other API, or start a second call. Only the model
 * is locked (fieldMask): the device's setup (tools, system instruction, voice, transcripts) still applies.
 */
export async function mintLiveToken(
  deps: GeminiDeps,
  model: string,
  now: number,
): Promise<{ token: string; expiresAt: number }> {
  const key = deps.key()
  if (key === null || key.trim() === '') throw new GeminiError(401, 'no key')
  const fetcher = deps.fetchImpl ?? fetch
  const expiresAt = now + LIVE_TOKEN_TTL_MS
  let response: Response
  try {
    response = await fetcher(`${GEMINI_BASE}/v1beta/auth_tokens`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key.trim(), 'content-type': 'application/json' },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(expiresAt).toISOString(),
        newSessionExpireTime: new Date(now + LIVE_TOKEN_START_MS).toISOString(),
        bidiGenerateContentSetup: { model: model.startsWith('models/') ? model : `models/${model}` },
        // Lock ONLY the model. With no field mask Google takes the whole setup from this token and ignores the
        // device's own (its tools, system instruction, voice and transcripts): a linked phone's call then had no
        // delegate tool and answered "I can't send that, do it yourself" (22 Oct 2026, verified on the real API).
        fieldMask: 'model',
      }),
    })
  } catch {
    throw new GeminiError(0, 'network')
  }
  if (!response.ok) throw new GeminiError(response.status, errorMessage(await response.text()))
  const body = (await response.json().catch(() => ({}))) as { name?: unknown }
  if (typeof body.name !== 'string' || body.name === '') throw new GeminiError(502, 'no token')
  return { token: body.name, expiresAt }
}
