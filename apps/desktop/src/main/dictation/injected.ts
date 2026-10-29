/**
 * Names the recogniser said that the speaker did not (29 Oct 2026: a project's name and two memory page
 * titles typed into his dictations). Biasing a speech model towards a list of names makes it say those
 * names into quiet stretches, breaths and noise. A stretch of words that is nothing but known names is that kind of
 * filler: it is dropped. A name inside real speech ("send it to Initech") stays.
 *
 * The same rule runs on every path: each settled stretch of the live model, a replayed recording, a batch or chunked
 * transcription (split into sentences), and the clean-up model may never bring in a name the transcript did not have.
 */
import { findWords } from '@agent/core'

/** Words that are not speech content on their own: they never make a stretch "real". */
const FILLER = new Set(['um', 'uh', 'er', 'erm', 'ah', 'oh', 'hmm', 'mm', 'the', 'a', 'an', 'and', 'for', 'of', 'to', 'in', 'on', 'at', 'with'])

/** The lower-case words of every name, split like search splits them ("Initech" -> londa, corp). */
export function nameWords(names: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const name of names) for (const word of findWords(name)) out.add(word)
  return out
}

/** True when the stretch is only names (and filler): at least one name word, and no other word at all. */
export function onlyNames(stretch: string, words: ReadonlySet<string>): boolean {
  if (words.size === 0) return false
  const said = findWords(stretch)
  let named = 0
  for (const word of said) {
    if (words.has(word)) named += 1
    else if (!FILLER.has(word)) return false
  }
  return named > 0
}

/**
 * The text cut into stretches at sentence ends and at the places two stretches were glued together without a space
 * ("for?Cosmiprint", "URL.Zernio"). Each piece keeps its own spacing and punctuation, so joining them gives the text.
 */
export function stretches(text: string): string[] {
  // A sentence ends at . ! ? (and any closing quote or bracket) followed by a space or a capital letter, so
  // "growos.ai" and "3.5" stay whole.
  return text.split(/(?<=[.!?]+["')\]]*)(?=\s|\p{Lu})/u).filter((piece) => piece !== '')
}

export interface Stripped {
  text: string
  /** The stretches taken out, as they were. */
  dropped: string[]
}

/** Takes out every stretch that is only names. Text with no names, or names inside real speech, comes back as it was. */
export function stripInjectedNames(text: string, names: readonly string[]): Stripped {
  const words = nameWords(names)
  if (words.size === 0 || text.trim() === '') return { text, dropped: [] }
  const dropped: string[] = []
  const kept: string[] = []
  for (const piece of stretches(text)) {
    if (onlyNames(piece, words)) dropped.push(piece.trim())
    else kept.push(piece)
  }
  if (dropped.length === 0) return { text, dropped }
  return { text: tidyJoin(kept), dropped }
}

/** Joins kept pieces, putting back a space where a dropped piece had been the only thing between two words. */
function tidyJoin(pieces: string[]): string {
  let out = ''
  for (const piece of pieces) {
    if (out !== '' && !/\s$/.test(out) && !/^\s/.test(piece)) out += ' '
    out += piece
  }
  return out.replace(/[ \t]{2,}/g, ' ').trim()
}

/** How many times each name is said in the text (whole words, any case). */
export function nameCounts(text: string, names: readonly string[]): Map<string, number> {
  const said = findWords(text).join(' ')
  const counts = new Map<string, number>()
  for (const name of names) {
    const words = findWords(name)
    if (words.length === 0) continue
    const key = words.join(' ')
    if (counts.has(key)) continue
    // "Initech" is said as londa corp or initech, depending on how it was heard.
    const forms = new Set([key, words.join('')])
    let count = 0
    const padded = ` ${said} `
    for (const form of forms) {
      let from = 0
      for (;;) {
        const at = padded.indexOf(` ${form} `, from)
        if (at < 0) break
        count += 1
        from = at + form.length + 1
      }
    }
    counts.set(key, count)
  }
  return counts
}

/** The names the second text has more of than the first: a step that should only tidy brought them in. */
export function addedNames(before: string, after: string, names: readonly string[]): string[] {
  const had = nameCounts(before, names)
  const has = nameCounts(after, names)
  const added: string[] = []
  for (const [name, count] of has) if (count > (had.get(name) ?? 0)) added.push(name)
  return added
}
