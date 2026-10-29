/**
 * Names spelled right AFTER transcription, never by biasing the recogniser (29 Oct 2026). A recogniser told a list of
 * names turns unclear speech into those names ("it shows like" became a project's name) and says them into quiet
 * stretches. So the words are transcribed as heard, and afterwards a word or two that is plainly a mis-spelling of a
 * known name ("Cosmic print", "Londercorp", "Mo Kena") is respelled. It only ever replaces words that were said,
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
  const allowed = b.length >= 8 ? 2 : 1
  if (editDistance(a, b, allowed) <= allowed) return true
  // Same consonants in the same order, and most of the letters agree ("Mo Kena" for Mokoena).
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
 * starts with a capital letter (the recogniser heard a name, not an ordinary word such as "finances"), is not the
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
      if (!/^\p{Lu}/u.test(first.word)) continue
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
  return { text: out, changed }
}
