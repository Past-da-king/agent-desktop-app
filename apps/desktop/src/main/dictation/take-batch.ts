/**
 * One whole-audio pass for a recording, shared by the Electron app (dictation/setup.ts) and the headless node
 * (headless/runtime.ts), so both write a take down the same way: the phone's names and languages in front of this
 * computer's own, ONE request over all of it, then names spelled right. No Electron here.
 */
import { applyAliases, EMPTY_VOCABULARY, type Vocabulary } from '../memory/vocabulary'
import type { VoiceService } from '../voice/service'
import type { BatchResult } from './controller'
import { stripInjectedNames } from './injected'
import { respellNames } from './respell'
import { MAX_SPEECH_LANGUAGES, cleanVocabulary } from './transcriber'
import { transcribeWhole } from './whole'

export type TakeExtra = { names?: string[]; languages?: string[] }

export interface TakeBatchDeps {
  voice: Pick<VoiceService, 'transcribe'>
  /** This computer's own languages, English first. */
  languages: () => string[]
  /** The names this computer's memory knows, read when a take is written down (the last list when it fails). */
  vocabulary?: () => Promise<Vocabulary>
  /** More words that should be spelled right: project names, the person's own name. */
  extraWords?: () => Promise<string[]>
  log: (message: string, fields?: Record<string, string | number | boolean>) => void
}

/** The words from memory and projects, cleaned, as the pass gets them. */
export async function loadWords(deps: Pick<TakeBatchDeps, 'vocabulary' | 'extraWords'>): Promise<string[]> {
  const vocabulary = (await deps.vocabulary?.().catch(() => null)) ?? EMPTY_VOCABULARY
  const extra = (await deps.extraWords?.().catch(() => [])) ?? []
  return cleanVocabulary([...extra, ...vocabulary.names, ...vocabulary.aliases.map((alias) => alias.name)])
}

/** Mis-heard names respelled (only words that were said), then any stretch of nothing but names left out. */
export function spellNames(text: string, names: string[], log: TakeBatchDeps['log']): string {
  const respelled = respellNames(text, names)
  if (respelled.changed.length > 0) log('Dictation respelled names', { count: respelled.changed.length })
  const stripped = stripInjectedNames(respelled.text, names)
  for (const stretch of stripped.dropped) log('Dictation left out a stretch of only names', { characters: stretch.length })
  return stripped.text
}

/**
 * The whole-take pass. `words` is the list the caller keeps (the app refreshes it as a dictation starts); without it the
 * words are read from memory for each take.
 */
export function createTakeBatch(deps: TakeBatchDeps, words?: () => string[]) {
  const known = async (): Promise<string[]> => (words === undefined ? loadWords(deps) : words())
  const raw = async (pcm: Buffer, signal: AbortSignal, onUpdate: ((text: string, interim: string) => void) | undefined, extra: TakeExtra | undefined, own: string[]): Promise<BatchResult> => {
    // A linked phone's own names go in front of the ones memory gives, and its languages in front of this computer's.
    const sent = (extra?.languages ?? []).concat(deps.languages()).filter((tag, index, all) => all.findIndex((other) => other.toLowerCase() === tag.toLowerCase()) === index)
    const speech = { names: cleanVocabulary([...(extra?.names ?? []), ...own]), languageCodes: sent.slice(0, MAX_SPEECH_LANGUAGES), mode: 'verbatim' as const }
    return transcribeWhole(pcm, signal, {
      one: (audio, audioSignal) => deps.voice.transcribe(audio, { ...speech, signal: audioSignal }),
      log: deps.log,
      ...(onUpdate === undefined ? {} : { onUpdate }),
    })
  }
  return async (pcm: Buffer, signal: AbortSignal, onUpdate?: (text: string, interim: string) => void, extra?: TakeExtra): Promise<BatchResult> => {
    const own = await known()
    const names = cleanVocabulary([...(extra?.names ?? []), ...own])
    const result = await raw(pcm, signal, onUpdate, extra, own)
    if (!result.ok) return result
    const aliased = applyAliases(result.text, (await deps.vocabulary?.().catch(() => null)) ?? EMPTY_VOCABULARY)
    return { ok: true, text: spellNames(aliased, names, deps.log) }
  }
}
