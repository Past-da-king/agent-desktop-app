/**
 * @-mentions in the message box (29 Oct 2026): typing '@' offers the person's projects, and a message that names one
 * goes to that project's current chat instead of the chat it was typed in. Pure, so the window, the main process and
 * the tests share it; the phone mirrors it (phone remote/Mentions.kt). Nothing here knows anyone's projects: the list
 * always comes from the project rows.
 */

/** One project as the picker shows it: small, so a phone on mobile data can keep the list. */
export interface MentionProject {
  id: string
  name: string
  aliases: string[]
  glyph: string
  color: string
  /** A picture icon (data URL), or '' for the glyph. */
  image: string
  /** On the rail: when it was put there (its place), else 0. */
  railAt: number
}

/** The shape of a project row this needs (core ProjectRow has more). */
export interface MentionSource {
  id: string
  name: string
  aliases?: string[]
  icon: { glyph: string; color: string; image?: string }
  hidden: boolean
  railAt?: number | null
}

/** The projects a mention can name: hidden ones are left out, as the rail leaves them out. */
export function mentionProjects(rows: MentionSource[]): MentionProject[] {
  return rows
    .filter((row) => !row.hidden && row.name.trim() !== '')
    .map((row) => ({
      id: row.id,
      name: row.name.trim(),
      aliases: (row.aliases ?? []).map((alias) => alias.trim()).filter((alias) => alias !== ''),
      glyph: row.icon.glyph,
      color: row.icon.color,
      image: row.icon.image ?? '',
      railAt: typeof row.railAt === 'number' ? row.railAt : 0,
    }))
    .sort((a, b) => Number(b.railAt > 0) - Number(a.railAt > 0) || (a.railAt > 0 && b.railAt > 0 ? a.railAt - b.railAt : 0) || a.name.localeCompare(b.name))
}

/** A short fingerprint of the list: a phone that already has this one is told "same" and sent nothing. */
export function mentionStamp(list: MentionProject[]): string {
  const text = JSON.stringify(list)
  // FNV-1a, 32 bit, twice with different seeds: plenty to tell two lists apart, and the same on every side.
  let a = 0x811c9dc5
  let b = 0x01000193 ^ text.length
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0
  }
  return `${a.toString(36)}${b.toString(36)}`
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '')
}

/** How well `query` fits `name`: 0 for not at all. Typed letters in order also count ("ada" finds Agent Desktop App). */
function fit(query: string, name: string): number {
  const q = query.toLowerCase().replace(/\s+/g, ' ').trim()
  const n = name.toLowerCase()
  if (q === '') return 1
  if (n === q) return 100
  if (n.startsWith(q)) return 90 - Math.min(9, n.length - q.length) / 10
  const nameWords = words(n)
  const queryWords = words(q)
  if (queryWords.length > 0 && queryWords.every((word) => nameWords.some((each) => each.startsWith(word)))) return 80
  if (n.includes(q)) return 70
  // Initials: "ada" for Agent Desktop App.
  const initials = nameWords.map((word) => word[0] ?? '').join('')
  const bare = q.replace(/[^\p{L}\p{N}]/gu, '')
  if (bare.length >= 2 && initials.startsWith(bare)) return 65
  // The letters in order, the closer together the better.
  let at = -1
  let first = -1
  for (const char of bare) {
    at = n.indexOf(char, at + 1)
    if (at < 0) return 0
    if (first < 0) first = at
  }
  if (bare.length < 2) return 0
  const spread = at - first + 1 - bare.length
  return Math.max(1, 40 - spread * 2)
}

/** The projects that fit what he typed after '@', best first. An empty query lists them all (rail order, then name). */
export function rankMentions(query: string, list: MentionProject[], limit = 8): MentionProject[] {
  const scored = list
    .map((project, index) => ({ project, index, score: Math.max(fit(query, project.name), ...project.aliases.map((alias) => fit(query, alias) * 0.95)) }))
    .filter((entry) => entry.score > 0)
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.slice(0, limit).map((entry) => entry.project)
}

/** The '@...' word being typed at the caret, for the picker: where it starts and what follows the '@'; null for none. */
export function mentionAtCaret(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)))
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  // '@' starts a word: the message's start or after a space (never an email address).
  if (at > 0 && !/\s/.test(before.charAt(at - 1))) return null
  const query = before.slice(at + 1)
  // A project name can have spaces; a line break, a long run or a second '@' ends it.
  if (/[\n@]/.test(query) || query.length > 40) return null
  return { start: at, query }
}

/** The '@' word is a whole name already, followed by a space (just picked or typed out): the list has nothing to add. */
export function mentionDone(query: string, list: MentionProject[]): boolean {
  if (!/\s$/.test(query)) return false
  const said = query.trim().toLowerCase()
  return list.some((project) => [project.name, ...project.aliases].some((name) => name.toLowerCase() === said))
}

/** The text with the picked project written in for the '@...' word at the caret, and where the caret goes. */
export function insertMention(text: string, caret: number, name: string): { text: string; caret: number } {
  const found = mentionAtCaret(text, caret)
  if (found === null) return { text, caret }
  const after = text.slice(caret).replace(/^\S*/, '').replace(/^ +/, '')
  const head = `${text.slice(0, found.start)}@${name} `
  return { text: head + after, caret: head.length }
}

/** A name as the person might type it: any case, spaces and punctuation ignored ("agentdesktopapp", "Agent-Desktop"). */
function bare(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/** The project a whole '@' word names exactly (its name or another name, any case, spaces and punctuation ignored). */
export function exactMention(word: string, list: MentionProject[]): MentionProject | null {
  const said = bare(word)
  if (said === '') return null
  return list.find((project) => bare(project.name) === said) ?? list.find((project) => project.aliases.some((alias) => bare(alias) === said)) ?? null
}

/**
 * The message box shows a picked project as a chip in front of the words (29 Oct 2026). The message itself stays
 * '@Name words', so the computer routes it the same way whoever typed it: this splits it into the chip and the rest.
 */
export function chipOf(text: string, list: MentionProject[]): { project: MentionProject; rest: string } | null {
  if (!text.startsWith('@')) return null
  const names = list.flatMap((project) => [project.name, ...project.aliases].map((name) => ({ project, name }))).sort((a, b) => b.name.length - a.name.length)
  const lower = text.slice(1).toLowerCase()
  const hit = names.find((entry) => lower.startsWith(entry.name.toLowerCase()) && /^(\s|$)/.test(text.slice(1 + entry.name.length)))
  if (hit === undefined) return null
  return { project: hit.project, rest: text.slice(1 + hit.name.length).replace(/^\s/, '') }
}

/** The message with a chip in front: '@Name rest'. */
export function withChip(project: MentionProject, rest: string): string {
  return `@${project.name} ${rest}`
}

/**
 * Typing turns a whole '@name' into a chip as soon as a space follows it ("@acme " -> [Acme]): the project it
 * names exactly, and the words without it. Null while it is not a whole name yet.
 */
export function chipFromTyping(text: string, caret: number, list: MentionProject[]): { project: MentionProject; rest: string; caret: number } | null {
  if (caret <= 0 || !/\s/.test(text.charAt(caret - 1))) return null
  const found = mentionAtCaret(text, caret - 1)
  if (found === null) return null
  const project = exactMention(found.query, list)
  if (project === null) return null
  const rest = `${text.slice(0, found.start)}${text.slice(caret)}`.replace(/^\s+/, '')
  return { project, rest, caret: Math.max(0, found.start) }
}

/** Picking from the list: the chip, and the words without the '@...' being typed. */
export function chipFromPick(text: string, caret: number, project: MentionProject): { project: MentionProject; rest: string; caret: number } {
  const found = mentionAtCaret(text, caret)
  if (found === null) return { project, rest: text, caret }
  const after = text.slice(caret).replace(/^\S*/, '')
  const rest = `${text.slice(0, found.start)}${after}`.replace(/^\s+/, '')
  return { project, rest, caret: found.start }
}

export interface ParsedMention {
  project: MentionProject
  /** The message without the mention. */
  rest: string
}

const BOUNDARY = /^($|[\s,.:;!?)])/

/**
 * The one project a message names with '@' (exact name or other name, any case, at the start of a word), and the
 * message without it. Null when it names none, or names two different projects (then it is the main agent's call).
 */
export function parseMention(text: string, list: MentionProject[]): ParsedMention | null {
  const names = list.flatMap((project) => [project.name, ...project.aliases].map((name) => ({ project, name }))).sort((a, b) => b.name.length - a.name.length)
  const hits: Array<{ project: MentionProject; start: number; end: number }> = []
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    if (i > 0 && !/\s/.test(text.charAt(i - 1))) continue
    const tail = text.slice(i + 1)
    const lower = tail.toLowerCase()
    const hit = names.find((entry) => lower.startsWith(entry.name.toLowerCase()) && BOUNDARY.test(tail.slice(entry.name.length)))
    if (hit !== undefined) hits.push({ project: hit.project, start: i, end: i + 1 + hit.name.length })
  }
  if (hits.length === 0) return null
  const first = hits[0] as (typeof hits)[number]
  if (hits.some((hit) => hit.project.id !== first.project.id)) return null
  let rest = text
  for (const hit of [...hits].reverse()) rest = `${rest.slice(0, hit.start)}${rest.slice(hit.end)}`
  rest = rest
    .replace(/^[\s,:;-]+/, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.:;!?])/g, '$1')
    .trim()
  return { project: first.project, rest }
}

/** What the sending chat shows once a mention went out (meta.mention on a notice row). */
export interface MentionNotice {
  project: string
  name: string
  chat: string
  /** A chat made for it (the project had none). */
  fresh: boolean
  /** The start of what he sent, for the line. */
  said?: string
}

export function mentionNoticeOf(meta: Record<string, unknown>): MentionNotice | null {
  const value = meta['mention']
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v['chat'] !== 'string' || v['chat'] === '' || typeof v['name'] !== 'string') return null
  return { project: typeof v['project'] === 'string' ? v['project'] : '', name: v['name'], chat: v['chat'], fresh: v['fresh'] === true, ...(typeof v['said'] === 'string' && v['said'] !== '' ? { said: v['said'] } : {}) }
}

/** The project's reply as the sending chat shows it: a card with the project's name and colour (meta.mentionReply). */
export interface MentionReply extends MentionNotice {
  glyph: string
  color: string
}

export function mentionReplyOf(meta: Record<string, unknown>): MentionReply | null {
  const value = meta['mentionReply']
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v['chat'] !== 'string' || v['chat'] === '' || typeof v['name'] !== 'string') return null
  return { project: typeof v['project'] === 'string' ? v['project'] : '', name: v['name'], chat: v['chat'], fresh: false, glyph: typeof v['glyph'] === 'string' ? v['glyph'] : '', color: typeof v['color'] === 'string' ? v['color'] : '' }
}

