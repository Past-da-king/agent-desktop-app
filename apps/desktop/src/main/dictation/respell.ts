/**
 * Names spelled right AFTER transcription, never by biasing the recogniser (29 Oct 2026). A recogniser told a list of
 * names turns unclear speech into those names ("it shows like" became a project's name) and says them into quiet
 * stretches. So the words are transcribed as heard, and afterwards a word or two that is plainly a mis-spelling of a
 * known name ("Cosmic print", "Initeck", "Mo Kena") is respelled. It only ever replaces words that were said,
 * with a name that sounds the same; it never adds one.
 */
import { editDistance } from '@agent/core'

/** A rough sound key: lower-case letters, common spellings of the same sound made one, double letters single. */
export function soundKey(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z]/g, '')
    .replace(/ph/g, 'f')
    .replace(/ck|q|c(?=[aou]|$|[^eiy])/g, 'k')
    .replace(/c/g, 's')
    .replace(/z/g, 's')
    .replace(/x/g, 'ks')
    .replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1')
}

/** The consonants of a sound key, the first letter kept: "fakeci" -> "fks". */
function skeleton(key: string): string {
  return key.slice(0, 1) + key.slice(1).replace(/[aeiou]/g, '')
}

/** True when `heard` sounds like `name` closely enough to be a mis-spelling of it. */
export function soundsLike(heard: string, name: string): boolean {
  const a = soundKey(heard)
  const b = soundKey(name)
  if (b.length < 5 || a.length < 4) return false
  if (a === b) return true
  // A name of several words ("Strat Edge Slack") shares most of its letters with ordinary phrases ("Strat Edge sync"):
  // one letter off at most. A long one-word name may be two off ("Northwind").
  const allowed = b.length >= 8 && !/\s/.test(name.trim()) ? 2 : 1
  if (editDistance(a, b, allowed) <= allowed) return true
  // Same consonants in the same order, and most of the letters agree ("Mo Kena" for Mokoena).
  if (/\s/.test(name.trim())) return false
  const sa = skeleton(a)
  const sb = skeleton(b)
  return sa.length >= 4 && sa === sb && editDistance(a, b, Math.ceil(b.length * 0.35)) <= Math.ceil(b.length * 0.35)
}

interface Token {
  word: string
  start: number
  end: number
}

function tokens(text: string): Token[] {
  const out: Token[] = []
  const pattern = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) out.push({ word: match[0], start: match.index, end: match.index + match[0].length })
  return out
}

/**
 * Respells mis-heard names. A window of one to three words is replaced by a name only when it sounds like that name,
 * is a name as heard (one word with a capital letter, or several words that together sound like it), is not the
 * name already, and is the same number of words or more (so a name never adds a word). Longer names are tried first.
 */
export function respellNames(text: string, names: readonly string[]): { text: string; changed: Array<{ heard: string; name: string }> } {
  const candidates = [...new Set(names.map((name) => name.trim()).filter((name) => name.length >= 3))].sort((a, b) => b.length - a.length)
  if (candidates.length === 0 || text.trim() === '') return { text, changed: [] }
  const words = tokens(text)
  const changed: Array<{ heard: string; name: string }> = []
  const replacements: Array<{ start: number; end: number; name: string }> = []
  let index = 0
  while (index < words.length) {
    let taken = 0
    for (let size = 3; size >= 1 && taken === 0; size -= 1) {
      if (index + size > words.length) continue
      const window = words.slice(index, index + size)
      const first = window[0]
      const last = window[size - 1]
      if (first === undefined || last === undefined) continue
      // The words must be one stretch: nothing but spaces between them.
      const span = text.slice(first.start, last.end)
      if (!/^[\p{L}\p{N}'’-]+(?:[ \t]+[\p{L}\p{N}'’-]+)*$/u.test(span)) continue
      // One word must have been heard as a name (a capital letter); two or three lower-case words that together
      // sound like one name ("cosmic print") are a name split up, not ordinary speech.
      if (size === 1 && !/^\p{Lu}/u.test(first.word)) continue
      for (const name of candidates) {
        const nameWords = name.split(/\s+/).length
        if (nameWords > size) continue
        if (span.toLowerCase() === name.toLowerCase()) break
        // "Finances" is Finance said in another form, not a mis-hearing: left as said.
        const plainHeard = span.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
        const plainName = name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
        if (plainHeard.startsWith(plainName) || plainName.startsWith(plainHeard)) continue
        if (soundsLike(span, name)) {
          replacements.push({ start: first.start, end: last.end, name })
          changed.push({ heard: span, name })
          taken = size
          break
        }
      }
      if (taken === 0 && size === 1 && candidates.some((name) => name.toLowerCase() === first.word.toLowerCase())) taken = 1
    }
    index += taken > 0 ? taken : 1
  }
  let out = text
  for (const replacement of replacements.reverse()) out = out.slice(0, replacement.start) + replacement.name + out.slice(replacement.end)
  const inContext = respellInContext(out, candidates)
  return { text: inContext.text, changed: [...changed, ...inContext.changed] }
}

/** Ordinary business words that mark a company name being talked about (language, not anyone's names). */
const COMPANY_WORDS = new Set(['team', 'letterhead', 'platform', 'tender', 'tenders', 'website', 'site', 'company', 'project', 'projects', 'bid', 'bids', 'invoice', 'proposal', 'brand', 'logo', 'office', 'directors', 'staff', 'client', 'clients', 'app', 'module', 'email'])
/** Words before or after a window that mean he is talking ABOUT the mistake, not making it ("it said started edge instead of"). */
const META_WORDS = new Set(['said', 'says', 'saying', 'say', 'instead', 'spelled', 'spelt', 'spell', 'spelling', 'called', 'supposed', 'written', 'write', 'wrote', 'typed', 'types', 'heard', 'hear', 'transcribed', 'transcribes', 'wrong', 'misheard', 'confuses', 'confused', 'quote'])
const NEAR = 4

/** How far a heard first word is from the name's first word, with a trailing -ed or -a said away ("started", "strata"). */
function firstWordDistance(heard: string, nameWord: string): number {
  const a = soundKey(heard)
  const b = soundKey(nameWord)
  if (a === '' || b === '') return 99
  const stripped = a.length > b.length + 1 ? a.replace(/(ed|a|s|ing)$/, '') : a
  return Math.min(editDistance(a, b, 3), editDistance(stripped, b, 3))
}

/**
 * Names of several words said wrong only in their FIRST word ("started edge", "that edge", "strata edge", "strat-ed edge"
 * for "Strat Edge"), put right when the words around them show a company is being talked about. Built from the names list
 * by sound, not from a map: the later words must be the name's own, the first must be close in sound, and either another
 * word of a longer name that starts the same way ("Strat Edge Solutions", "Strat CMS" gives Solutions and CMS) or an
 * ordinary business word (team, letterhead, tender) must stand next to it. Left alone: a window with no company next to it
 * ("on that edge of the table"), talk ABOUT the mistake ("it said started edge instead of Strat Edge") and any sentence
 * that already has the name spelled right.
 */
export function respellInContext(text: string, names: readonly string[]): { text: string; changed: Array<{ heard: string; name: string }> } {
  const multi = [...new Set(names.map((name) => name.trim()).filter((name) => /\s/.test(name) && name.length >= 5))]
  if (multi.length === 0 || text.trim() === '') return { text, changed: [] }
  const words = tokens(text)
  const lower = words.map((word) => word.word.toLowerCase().replace(/[-'’]+$/g, ''))
  // The sentence of every word, to see whether the name is already there right.
  const sentenceOf: number[] = []
  let sentence = 0
  words.forEach((word, index) => {
    sentenceOf[index] = sentence
    const next = words[index + 1]
    if (next !== undefined && /[.!?]/.test(text.slice(word.end, next.start))) sentence += 1
  })
  const replacements: Array<{ start: number; end: number; name: string }> = []
  const changed: Array<{ heard: string; name: string }> = []
  const claimed = new Set<number>()
  for (const name of multi.sort((a, b) => b.length - a.length)) {
    const parts = name.split(/\s+/)
    const head = parts[0] ?? ''
    const rest = parts.slice(1).map((part) => part.toLowerCase())
    // Words that make this name's company clear: the further words of longer names sharing its start, and the business words.
    const company = new Set<string>(COMPANY_WORDS)
    for (const other of multi) {
      const otherParts = other.split(/\s+/)
      if (other !== name && (otherParts[0] ?? '').toLowerCase() === head.toLowerCase()) for (const word of otherParts.slice(1)) company.add(word.toLowerCase())
    }
    for (const word of rest) company.delete(word)
    for (let index = 0; index + parts.length <= words.length; index += 1) {
      const window = words.slice(index, index + parts.length)
      if (window.some((_, offset) => claimed.has(index + offset))) continue
      const first = window[0]
      const last = window[parts.length - 1]
      if (first === undefined || last === undefined) continue
      if (!/^[\p{L}\p{N}'’-]+(?:[ \t]+[\p{L}\p{N}'’-]+)*$/u.test(text.slice(first.start, last.end))) continue
      if (lower.slice(index, index + parts.length).join(' ') === name.toLowerCase()) continue
      // "strat-ed edge" is the head plus an extra bit: the first token alone is the heard head.
      if (!rest.every((part, offset) => soundKey(lower[index + 1 + offset] ?? '') === soundKey(part))) continue
      const heardHead = lower[index] ?? ''
      if (firstWordDistance(heardHead, head) > 2 || heardHead === head.toLowerCase()) continue
      // Talk about the mistake is left as said.
      const before = lower.slice(Math.max(0, index - NEAR), index)
      const after = lower.slice(index + parts.length, index + parts.length + NEAR)
      if ([...before, ...after].some((word) => META_WORDS.has(word))) continue
      // A sentence that already has the name spelled right is not touched.
      const here = sentenceOf[index] ?? 0
      const exact = lower.some((_, at) => sentenceOf[at] === here && lower.slice(at, at + parts.length).join(' ') === name.toLowerCase())
      if (exact) continue
      const around = [...lower.slice(Math.max(0, index - NEAR), index), ...lower.slice(index + parts.length, index + parts.length + NEAR)]
      // Three or more words matching ("strat-ed edge solutions") are their own evidence; two need a company word beside them.
      if (parts.length < 3 && !around.some((word) => company.has(word))) continue
      replacements.push({ start: first.start, end: last.end, name })
      changed.push({ heard: text.slice(first.start, last.end), name })
      for (let offset = 0; offset < parts.length; offset += 1) claimed.add(index + offset)
    }
  }
  let out = text
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) out = out.slice(0, replacement.start) + replacement.name + out.slice(replacement.end)
  return { text: out, changed }
}
