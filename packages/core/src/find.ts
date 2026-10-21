/**
 * Finding a thing the way a person says it (22 Oct 2026): "show me the lender select" finds Acme Lender
 * Selector, "strategic website" (dictation for "Strat Edge Website") finds Strat Edge Website. Filler words are
 * dropped, then every word left must match a word of the thing by prefix or a small typo, in any of its fields. Used
 * by the command palette and by the agent's project_open tool, so both find the same thing.
 */

/** Words that carry no meaning in "show me the ...", "open my ... project, please". */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  'show', 'me', 'the', 'open', 'go', 'to', 'take', 'find', 'project', 'projects', 'my', 'a', 'an', 'please', 'can', 'you', 'up', 'pull', 'bring', 'jump', 'page', 'of', 'for',
])

/** One field of a candidate: its text and how much a hit in it counts (1 for the name). */
export interface FindField {
  text: string
  weight: number
  /** Allow typo matches in this field. Off for long free text, where a typo match is mostly noise. */
  fuzzy?: boolean
}

export interface FindCandidate<T> {
  item: T
  fields: FindField[]
  /** Ranks ties: a smaller number first. Defaults to the candidate's place in the list. */
  order?: number
}

export interface FindHit<T> {
  item: T
  score: number
}

/** Lower-case words: split on anything not a letter or digit, and at camelCase joins ("StudyCanvas"). */
export function findWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '')
}

/** The query's words that mean something; all of them when every word is filler ("open"). */
export function queryWords(query: string): string[] {
  const all = findWords(query)
  const kept = all.filter((word) => !FILLER_WORDS.has(word))
  return kept.length > 0 ? kept : all
}

/** Optimal string alignment distance (Damerau-Levenshtein with adjacent swaps), stopping early past `max`. */
export function editDistance(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let before: number[] = []
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current: number[] = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, (before[j - 2] ?? 0) + 1)
      current.push(value)
      if (value < best) best = value
    }
    if (best > max) return max + 1
    before = previous
    previous = current
  }
  return previous[b.length] ?? 0
}

/** How many typos a word of this length may carry: none under 4 letters, one up to 6, two from 7. */
export function typoAllowance(length: number): number {
  if (length < 4) return 0
  return length < 7 ? 1 : 2
}

/** How well one query word matches one target word, 0 to 1. */
export function wordScore(query: string, target: string, fuzzy = true): number {
  if (query === target) return 1
  if (target.startsWith(query)) return 0.8 + 0.15 * (query.length / target.length)
  // "strategic" said for "strat": the target word is the start of what was said.
  if (target.length >= 4 && query.startsWith(target)) return 0.7
  if (!fuzzy) return 0
  const allow = typoAllowance(Math.min(query.length, target.length))
  if (allow > 0) {
    const whole = editDistance(query, target, allow)
    if (whole <= allow) return 0.75 - 0.1 * whole
    // A typo in the start of a longer word: "selct" for "selector".
    if (target.length > query.length) {
      const start = editDistance(query, target.slice(0, query.length), allow)
      if (start <= allow) return 0.6 - 0.1 * start
    }
  }
  return 0
}

/** The whole phrase run together against a field run together: "studycanvas" for "Study Canvas", "rmblr" for "rumbler". */
function phraseScore(compactQuery: string, compactTarget: string): number {
  if (compactQuery.length < 4 || compactTarget === '') return 0
  if (compactQuery === compactTarget) return 1
  if (compactTarget.startsWith(compactQuery)) return 0.8 + 0.15 * (compactQuery.length / compactTarget.length)
  const allow = Math.min(3, Math.floor(compactQuery.length / 3))
  const whole = editDistance(compactQuery, compactTarget, allow)
  if (whole <= allow) return 0.7 - 0.1 * whole
  if (compactTarget.length > compactQuery.length) {
    const start = editDistance(compactQuery, compactTarget.slice(0, compactQuery.length), allow)
    if (start <= allow) return 0.6 - 0.1 * start
  }
  return 0
}

/** How well a query's words match a candidate's fields, 0 for not at all. The first field is its name. */
export function scoreCandidate(words: string[], fields: FindField[]): number {
  if (words.length === 0) return 0
  const prepared = fields.map((field) => ({ field, words: findWords(field.text) })).filter((each) => each.words.length > 0)
  if (prepared.length === 0) return 0

  // Word by word: every query word must land somewhere; each counts its best hit, weighted by its field.
  let total = 0
  let allFound = true
  for (const word of words) {
    let best = 0
    for (const { field, words: targets } of prepared) {
      for (const target of targets) {
        const score = wordScore(word, target, field.fuzzy !== false) * field.weight
        if (score > best) best = score
      }
    }
    if (best === 0) {
      allFound = false
      break
    }
    total += best
  }
  let score = allFound ? total / words.length : 0
  const name = prepared[0]
  if (allFound && name !== undefined && name.field === fields[0]) {
    // The one whose name is more fully said ranks first: "creek" ranks "Creek Leisure" over "Creek Collection Brand".
    const covered = name.words.filter((target) => words.some((word) => wordScore(word, target, false) > 0)).length
    score += 0.05 * (covered / name.words.length)
  }

  // The whole phrase run together against each field that allows typos.
  const compact = words.join('')
  for (const { field, words: targets } of prepared) {
    if (field.fuzzy === false) continue
    const phrase = phraseScore(compact, targets.join('')) * field.weight * 0.95
    if (phrase > score) score = phrase
  }
  return score
}

/** Every candidate that matches, best first. A query with no words matches nothing. */
export function findMatches<T>(query: string, candidates: FindCandidate<T>[]): FindHit<T>[] {
  const words = queryWords(query)
  if (words.length === 0) return []
  return candidates
    .map((candidate, index) => ({ candidate, index, score: scoreCandidate(words, candidate.fields) }))
    .filter((each) => each.score > 0)
    .sort((a, b) => b.score - a.score || (a.candidate.order ?? a.index) - (b.candidate.order ?? b.index))
    .map(({ candidate, score }) => ({ item: candidate.item, score }))
}

/** How far ahead the best hit must be to be the one meant, rather than one of several to ask about. */
export const CLEAR_LEAD = 0.1

/**
 * The one hit meant, or the close ones to ask about: `winner` when the best is alone or well ahead of the next;
 * otherwise `close` holds every hit near the best (at most five), best first.
 */
export function pickMatch<T>(hits: FindHit<T>[]): { winner: FindHit<T> | null; close: FindHit<T>[] } {
  const [first, second] = hits
  if (first === undefined) return { winner: null, close: [] }
  if (second === undefined || first.score - second.score >= CLEAR_LEAD) return { winner: first, close: [first] }
  return { winner: null, close: hits.filter((hit) => first.score - hit.score < CLEAR_LEAD).slice(0, 5) }
}

/** What a project is found by. */
export interface ProjectLike {
  name: string
  description: string
  path: string
  aliases?: string[]
}

/** The last part of a folder path: "C:\\work\\lender-selector" gives "lender-selector". */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  return parts[parts.length - 1] ?? ''
}

/** A project's fields, scored in this order: name, other names, description, folder name. */
export function projectFields(project: ProjectLike): FindField[] {
  // Old rows have no aliases; a synced row from a newer build could carry anything, so only strings count.
  const aliases = Array.isArray(project.aliases) ? project.aliases.filter((alias): alias is string => typeof alias === 'string') : []
  return [
    { text: project.name, weight: 1 },
    ...aliases.map((alias) => ({ text: alias, weight: 0.95 })),
    { text: project.description, weight: 0.6, fuzzy: false },
    { text: folderName(project.path), weight: 0.55, fuzzy: false },
  ]
}

/** Projects matching what was said, best first. */
export function findProjects<P extends ProjectLike>(query: string, projects: P[]): FindHit<P>[] {
  return findMatches(
    query,
    projects.map((project) => ({ item: project, fields: projectFields(project) })),
  )
}

/** Other names typed on one line, "Rumbler, RMBLR app": trimmed, no repeats, at most 12 of up to 60 letters. */
export function parseAliases(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/[,;\n]/)) {
    const clean = raw.trim().replace(/\s+/g, ' ').slice(0, 60)
    if (clean === '' || seen.has(clean.toLowerCase())) continue
    seen.add(clean.toLowerCase())
    out.push(clean)
    if (out.length >= 12) break
  }
  return out
}
