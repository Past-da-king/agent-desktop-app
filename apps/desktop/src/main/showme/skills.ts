/**
 * The route for a walk comes from what the agent already knows ("show me how", 10 Nov 2026): a memory page of kind
 * skill or how-to, or a learned app (its about text and where it lives). This finds the one that fits the window he
 * is on (its program, its title, and the page address when it is a browser) and what he asked. Nothing here names a
 * product: a page fits because its own words and addresses fit.
 *
 * Pure: the pages and apps come in as data, so the lookup is tested without a store.
 */
import type { ActiveWindow } from './screen'

export interface SkillSource {
  id: string
  kind: 'memory' | 'app'
  title: string
  /** The page body, or the app's about text. */
  text: string
  /** Other names it answers to, and its topics. */
  names?: string
  /** Where it lives, when it is an app. */
  url?: string
  /** A memory page written as a skill ranks a little above a plain how-to. */
  skill?: boolean
}

export interface SkillMatch {
  source: SkillSource
  score: number
  /** Why it fits, for the log: "address app.example.com", "window title: example", "asked: pixel, create". */
  why: string[]
}

/** The rows this reads from, by shape, so the store's own types are not needed here. */
export interface MemoryLike {
  id: string
  title: string
  body: string
  kind: string
  topics?: string
  aliases?: string
  status?: string
}
export interface AppLike {
  id: string
  name: string
  startUrl: string
  about: string
}

export const MAX_SKILL_CHARS = 12_000

export function skillSources(memories: MemoryLike[], apps: AppLike[]): SkillSource[] {
  const out: SkillSource[] = []
  for (const row of memories) {
    if (row.kind !== 'skill' && row.kind !== 'how-to') continue
    if (row.status === 'closed' || row.body.trim() === '') continue
    out.push({ id: row.id, kind: 'memory', title: row.title, text: row.body, names: [row.aliases ?? '', row.topics ?? ''].join(', '), ...(row.kind === 'skill' ? { skill: true } : {}) })
  }
  for (const app of apps) {
    if (app.about.trim() === '' && app.startUrl.trim() === '') continue
    out.push({ id: app.id, kind: 'app', title: app.name, text: app.about, url: app.startUrl })
  }
  return out
}

/** Words that say nothing about which product a window is: browsers, filler, and how a question starts. */
const NOISE = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'your', 'you', 'how', 'do', 'does', 'did', 'can', 'what', 'where', 'show', 'me', 'my',
  'to', 'in', 'on', 'of', 'a', 'an', 'is', 'it', 'i', 'at', 'or', 'new', 'tab', 'page', 'home', 'window', 'app', 'application', 'untitled', 'please',
  'google', 'chrome', 'microsoft', 'edge', 'mozilla', 'firefox', 'brave', 'opera', 'safari', 'vivaldi', 'arc', 'browser', 'msedge', 'exe', 'www', 'com', 'https', 'http',
  'set', 'get', 'make', 'add', 'use', 'open', 'go', 'click', 'guided', 'guide', 'anything', 'something',
])

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 && !NOISE.has(word))
}

/** "app.example.com" from an address, '' when there is none. */
export function hostOfUrl(url: string | undefined): string {
  if (url === undefined || url.trim() === '') return ''
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Every host a text mentions (full addresses and bare names like app.example.com). */
export function hostsIn(text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(/\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[/:?#\s)"'`\],.;]|$)/gi)) {
    const host = (m[1] ?? '').toLowerCase().replace(/^www\./, '')
    if (host !== '' && !/\.(md|ts|js|json|png|jpg|txt|html|css|exe|pdf)$/.test(host)) found.add(host)
  }
  return [...found]
}

function sameSite(a: string, b: string): boolean {
  if (a === '' || b === '') return false
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

/**
 * The page or app that fits this window and question best, or null when nothing fits well enough to trust as a route.
 * A fit needs a sign from the window itself (the address, or its title or program naming the page), or the question
 * naming the page clearly: a page that merely shares a common word with the question is not a route.
 */
export function matchSkill(sources: SkillSource[], window: Pick<ActiveWindow, 'process' | 'title' | 'url'>, question: string): SkillMatch | null {
  const host = hostOfUrl(window.url)
  const windowWords = new Set([...words(window.title), ...words(window.process.replace(/\.exe$/i, ''))])
  const asked = new Set(words(question))
  let best: SkillMatch | null = null
  for (const source of sources) {
    const why: string[] = []
    let score = 0
    let fromWindow = false
    const hosts = [...(source.url === undefined ? [] : [hostOfUrl(source.url)]), ...hostsIn(source.text)]
    if (host !== '' && hosts.some((each) => sameSite(host, each))) {
      score += 6
      fromWindow = true
      why.push(`address ${host}`)
    }
    const nameWords = new Set([...words(source.title), ...words(source.names ?? '')])
    const inTitle = [...nameWords].filter((word) => windowWords.has(word))
    if (inTitle.length > 0) {
      score += Math.min(6, inTitle.length * 3)
      fromWindow = true
      why.push(`window: ${inTitle.slice(0, 4).join(', ')}`)
    }
    const askedName = [...asked].filter((word) => nameWords.has(word))
    if (askedName.length > 0) {
      score += Math.min(6, askedName.length * 2)
      why.push(`asked: ${askedName.slice(0, 4).join(', ')}`)
    }
    const body = new Set(words(source.text.slice(0, 20_000)))
    const askedBody = [...asked].filter((word) => !nameWords.has(word) && body.has(word))
    score += Math.min(3, askedBody.length * 0.5)
    if (source.skill === true) score += 1
    const trusted = fromWindow || askedName.length >= 2
    if (!trusted || score < 4) continue
    if (best === null || score > best.score) best = { source, score, why }
  }
  return best
}

/** The skill as the planner reads it: its name, where it lives, and its text, cut to a size a small model reads fast. */
export function skillText(match: SkillMatch | null): string {
  if (match === null) return ''
  const { source } = match
  const head = `${source.kind === 'app' ? 'Learned app' : 'Skill page'}: ${source.title}${source.url === undefined || source.url === '' ? '' : ` (${source.url})`}`
  const body = source.text.trim()
  return `${head}\n${body.length > MAX_SKILL_CHARS ? `${body.slice(0, MAX_SKILL_CHARS)}\n[cut]` : body}`
}
