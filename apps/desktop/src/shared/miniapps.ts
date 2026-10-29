/**
 * Mini-apps (29 Oct 2026, docs/plans/mini-apps.md): the pure rules both sides use. What a saved app may contain, the
 * lint that refuses one drawing in colours, fonts or radii of its own or reaching for the network, which tools an app
 * may ever be granted, how a call is checked against its permissions, its icon, and its versions.
 *
 * Nothing here knows the person, his accounts or his setup: an app is whatever an agent made, judged by these rules.
 */
import type { MiniAppRow, MiniAppVersion } from '@agent/core'

// ---- limits -----------------------------------------------------------------------------------------------------

export const MINIAPP_MAX_FILES = 20
/** All its files together. */
export const MINIAPP_MAX_BYTES = 1_000_000
/** Versions kept besides the current one. */
export const MINIAPP_KEEP_VERSIONS = 10
/** Its own key-value store. */
export const MINIAPP_STORE_MAX_KEYS = 200
export const MINIAPP_STORE_MAX_BYTES = 256_000
/** Calls an app may make in a window of time (one app; a loop that runs away is cut off). */
export const MINIAPP_RATE = { calls: 40, perMs: 10_000 }
export const MINIAPP_PIN_CAP_DEFAULT = 8

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}\.(html|js|css|svg|json)$/

/** A new app's id: lower case so it can be a URL host (miniapp://<id>/). */
export function newMiniAppId(random: () => number = Math.random): string {
  let out = 'ma'
  for (let i = 0; i < 12; i += 1) out += Math.floor(random() * 36).toString(36)
  return out
}

export function isMiniAppId(value: string): boolean {
  return /^ma[a-z0-9]{6,30}$/.test(value)
}

// ---- tools an app may be granted ---------------------------------------------------------------------------------

/**
 * Never granted to an app, whatever it asks: anything that reaches the network or the computer, drives a browser, sees
 * secrets, changes the app itself or other agents, or asks the person in the agent's name (an app uses agent.ask).
 */
const NEVER: ReadonlySet<string> = new Set([
  'web_fetch', 'shell_run', 'run_code', 'run_script', 'files_write', 'files_move', 'files_pick',
  'ask_user', 'request_approval', 'notify_user', 'report', 'voice_note',
  'vault_list', 'vault_fill', 'vault_login', 'vault_save', 'vault_reveal', 'vault_passkey',
  'settings_set', 'app_action', 'app_update', 'prompt_rules', 'profile_create',
  'worker_create', 'worker_update', 'worker_secret_set', 'worker_delete', 'worker_control', 'worker_test',
  'apps_connect', 'open_url', 'send_file', 'device_tool',
  'delegate', 'helper_steer', 'helper_push', 'helper_stop',
])
const NEVER_PREFIX = ['browser_', 'miniapp_', 'device_', 'devices_', 'webapp_test', 'webapp_save', 'webapp_remove', 'project_', 'wake_']

/** Tools that only read: an app with the grant runs them without asking. Anything else asks him first (unless he allowed it). */
const READS: ReadonlySet<string> = new Set([
  'now', 'memory_search', 'memory_get', 'memory_history', 'chats_search', 'chat_read', 'task_list', 'routine_list',
  'files_list', 'files_read', 'files_find', 'apps_connected', 'apps_find_tools', 'webapp_list', 'worker_list', 'worker_logs',
  'worker_events', 'recordings_list', 'recordings_get', 'calendar_events', 'settings_get',
])

/** A Composio action that only reads, by its name (GOOGLECALENDAR_EVENTS_LIST, GMAIL_FETCH_EMAILS). */
export function readsBySlug(slug: string): boolean {
  return /_(LIST|GET|FETCH|SEARCH|FIND|READ|VIEW)(_|$)/.test(slug.toUpperCase())
}

/** The tool part of a permission ("apps_run:GMAIL_FETCH_EMAILS" -> "apps_run"). */
export function toolOf(permission: string): string {
  const at = permission.indexOf(':')
  return at < 0 ? permission : permission.slice(0, at)
}

export function grantable(tool: string): boolean {
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(tool)) return false
  if (NEVER.has(tool)) return false
  return !NEVER_PREFIX.some((prefix) => tool.startsWith(prefix))
}

/** What a call is: allowed and only reads, allowed and changes something (asks unless allowed), or refused (why). */
export type CallVerdict = { ok: true; reads: boolean; key: string } | { ok: false; why: string }

/**
 * A call checked against the app's permissions. `apps_run` needs the action's slug granted (or apps_run:* for any);
 * `webapp_run` needs "webapp_run:<app>/<tool>" (or webapp_run:<app>/*). The key is what "always allow" is stored as.
 */
export function checkCall(app: Pick<MiniAppRow, 'permissions'>, tool: string, args: Record<string, unknown>): CallVerdict {
  if (!grantable(tool)) return { ok: false, why: `${tool} is never available to a mini-app.` }
  const perms = new Set(app.permissions)
  if (tool === 'apps_run') {
    const slug = typeof args['slug'] === 'string' ? args['slug'].trim().toUpperCase() : ''
    if (slug === '') return { ok: false, why: 'apps_run needs a slug.' }
    if (!perms.has(`apps_run:${slug}`) && !perms.has('apps_run:*')) return { ok: false, why: `This app may not run ${slug} (not in its permissions).` }
    return { ok: true, reads: readsBySlug(slug), key: `apps_run:${slug}` }
  }
  if (tool === 'webapp_run') {
    const name = typeof args['app'] === 'string' ? args['app'].trim() : ''
    const which = typeof args['tool'] === 'string' ? args['tool'].trim() : ''
    if (!perms.has(`webapp_run:${name}/${which}`) && !perms.has(`webapp_run:${name}/*`)) return { ok: false, why: `This app may not run ${name}/${which} (not in its permissions).` }
    return { ok: true, reads: false, key: `webapp_run:${name}/${which}` }
  }
  if (!perms.has(tool)) return { ok: false, why: `This app may not call ${tool} (not in its permissions).` }
  return { ok: true, reads: READS.has(tool), key: tool }
}

/** Topics an app may listen to, and the permission each needs. */
export function topicAllowed(app: Pick<MiniAppRow, 'permissions'>, topic: string): boolean {
  const perms = new Set(app.permissions.map(toolOf))
  if (topic === 'data.task' || topic === 'data.goal') return perms.has('task_list')
  if (topic === 'data.trigger') return perms.has('routine_list')
  if (topic === 'data.memory') return perms.has('memory_search') || perms.has('memory_get')
  if (topic === 'calendar.changed') return perms.has('calendar_events')
  if (/^worker\.[A-Za-z0-9_-]{1,60}$/.test(topic)) return perms.has('worker_events')
  if (topic === 'refresh') return true
  return false
}

// ---- icons ------------------------------------------------------------------------------------------------------

/** The app's own icon names an app may use (renderer/ui/Icon.tsx). Kept as data so main, tests and the phone agree. */
export const MINIAPP_ICON_NAMES = [
  'home', 'tasks', 'memory', 'clock', 'apps', 'grid', 'chat', 'search', 'globe', 'shield', 'check', 'sun', 'moon', 'phone',
  'monitor', 'key', 'link', 'folder', 'server', 'bell', 'play', 'person', 'building', 'heart', 'eye', 'sync', 'palette',
  'lock', 'edit', 'cal', 'mail', 'shot', 'branch', 'file', 'bolt', 'code', 'term', 'doc', 'sound', 'pin',
] as const

export interface IconNode {
  tag: string
  attrs: Record<string, string>
}

const ICON_TAGS = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'g'])
const ICON_ATTRS = new Set([
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'points', 'transform',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'fill-rule', 'clip-rule',
])
const PAINT_OK = /^(none|currentColor)$/

/**
 * A drawn icon, reduced to shapes the rail can draw safely: only plain shapes, no script, no links, and paint only
 * in currentColor (so it takes the rail's colours in light, dark and every accent).
 */
export function parseIconSvg(svg: string): { ok: true; nodes: IconNode[] } | { ok: false; why: string } {
  const text = svg.trim()
  if (text.length > 4000) return { ok: false, why: 'An icon is at most 4,000 characters.' }
  const open = /^<svg\b([^>]*)>([\s\S]*)<\/svg>$/i.exec(text)
  if (open === null) return { ok: false, why: 'An icon is one <svg ...>...</svg> (24 by 24, drawn in currentColor).' }
  const nodes: IconNode[] = []
  const body = open[2] ?? ''
  const tagRe = /<\s*(\/?)\s*([a-zA-Z]+)([^>]*?)(\/?)\s*>/g
  const rest = body.replace(tagRe, '')
  if (rest.trim() !== '') return { ok: false, why: 'An icon holds shapes only, no text.' }
  let match: RegExpExecArray | null
  tagRe.lastIndex = 0
  while ((match = tagRe.exec(body)) !== null) {
    if (match[1] === '/') continue
    const tag = (match[2] ?? '').toLowerCase()
    if (!ICON_TAGS.has(tag)) return { ok: false, why: `An icon may use path, circle, rect, line, polyline, polygon, ellipse and g, not <${tag}>.` }
    const attrs: Record<string, string> = {}
    const attrRe = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
    let a: RegExpExecArray | null
    const raw = match[3] ?? ''
    if (raw.replace(attrRe, '').trim() !== '') return { ok: false, why: 'Icon attributes are written name="value".' }
    while ((a = attrRe.exec(raw)) !== null) {
      const name = (a[1] ?? '').toLowerCase()
      const value = a[3] ?? a[4] ?? ''
      if (!ICON_ATTRS.has(name)) return { ok: false, why: `An icon may not use the attribute ${name}.` }
      if ((name === 'fill' || name === 'stroke') && !PAINT_OK.test(value)) return { ok: false, why: `Icon ${name} must be currentColor or none, not "${value}".` }
      if (/[<>]|url\s*\(|javascript:/i.test(value)) return { ok: false, why: 'An icon may not link to anything.' }
      attrs[name === 'stroke-width' ? 'strokeWidth' : name === 'stroke-linecap' ? 'strokeLinecap' : name === 'stroke-linejoin' ? 'strokeLinejoin' : name === 'fill-rule' ? 'fillRule' : name === 'clip-rule' ? 'clipRule' : name] = value
    }
    nodes.push({ tag, attrs })
    if (nodes.length > 40) return { ok: false, why: 'An icon has at most 40 shapes.' }
  }
  if (nodes.length === 0) return { ok: false, why: 'An icon needs at least one shape.' }
  return { ok: true, nodes }
}

/** A name from the icon set, or a drawn SVG that passes parseIconSvg. */
export function checkIcon(icon: string): string | null {
  const value = icon.trim()
  if ((MINIAPP_ICON_NAMES as readonly string[]).includes(value)) return null
  if (value.startsWith('<')) {
    const parsed = parseIconSvg(value)
    return parsed.ok ? null : parsed.why
  }
  return `The icon is one of: ${MINIAPP_ICON_NAMES.join(', ')}; or a small <svg> drawn in currentColor.`
}

// ---- the lint -----------------------------------------------------------------------------------------------------

/** CSS named colours (and the system colour keywords): a colour must come from the app's tokens instead. */
const NAMED = new Set(
  ('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse ' +
    'chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta ' +
    'darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray grey ' +
    'green greenyellow honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral ' +
    'lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple ' +
    'mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite ' +
    'navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink ' +
    'plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue ' +
    'slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen ' +
    'canvas canvastext linktext visitedtext activetext buttonface buttontext buttonborder field fieldtext highlight highlighttext mark marktext graytext accentcolor accentcolortext').split(' '),
)

const COLOR_PROPS = '(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left|block|inline))?(?:-color)?|outline(?:-color)?|fill|stroke|box-shadow|text-shadow|caret-color|accent-color|column-rule(?:-color)?|text-decoration(?:-color)?|stop-color|flood-color|lighting-color|scrollbar-color)'

export interface LintFinding {
  file: string
  line: number
  rule: 'colour' | 'font' | 'radius' | 'network' | 'escape' | 'permission' | 'file' | 'icon' | 'manifest'
  text: string
}

function lineOf(text: string, index: number): number {
  let n = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1
  return n
}

/** Comments out of the way (so a note that says "#fff is not allowed" is not a finding), keeping line numbers. */
function stripComments(text: string, kind: 'css' | 'js' | 'html'): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ')
  if (kind === 'css') return text.replace(/\/\*[\s\S]*?\*\//g, blank)
  if (kind === 'html') return text.replace(/<!--[\s\S]*?-->/g, blank)
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:\\'"`])\/\/[^\n]*/g, (m, pre: string) => pre + blank(m.slice(pre.length)))
}

const NETWORK: Array<[RegExp, string]> = [
  [/\bhttps?:\/\//i, 'a web address (mini-apps have no network; data comes through agent.call)'],
  [/\bwss?:\/\//i, 'a socket address (no network)'],
  [/(?:src|href|action|poster|data)\s*=\s*["']\s*\/\/[^/]/i, 'an address on another host (no network)'],
  [/url\(\s*["']?\s*\/\/[^/]/i, 'an address on another host (no network)'],
  [/@import\b/i, '@import (link its own .css files with <link rel="stylesheet" href="name.css">)'],
  [/\bfetch\s*\(/, 'fetch() (no network; use agent.call)'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest (no network; use agent.call)'],
  [/\bnew\s+WebSocket\b|\bEventSource\b|\bWebTransport\b|\bRTCPeerConnection\b/, 'a network connection (no network)'],
  [/\bsendBeacon\b/, 'sendBeacon (no network)'],
  [/\bimport\s*\(/, 'import() (load only its own files with <script src>)'],
  [/\bimportScripts\b|\bnew\s+(?:Shared)?Worker\b|\bserviceWorker\b/, 'a worker (not available in a mini-app)'],
]

const ESCAPES: Array<[RegExp, string]> = [
  [/\bwindow\.open\s*\(|\bopen\s*\(\s*["'`]/, 'window.open (a mini-app opens nothing; it shows what it has)'],
  [/\b(?:window\.)?(?:top|parent|opener)\s*\.\s*(?:location|document|postMessage|agent|frames|window)\b|\bwindow\.(?:top|parent|opener)\b/, 'reaching the window around it (only agent.* talks to the app)'],
  [/\bdocument\.cookie\b|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bcaches\s*\./, 'browser storage (use agent.store)'],
  [/\b(?:window|document)\s*\.\s*location\b|\blocation\s*\.\s*(?:href\s*=|assign|replace)/, 'navigating away (a mini-app stays one page)'],
  [/<\s*(?:iframe|frame|object|embed|base|form)\b/i, 'a frame, object, base or form (not available in a mini-app)'],
  [/<\s*meta\s+[^>]*http-equiv/i, 'a meta http-equiv (the app sets its own rules)'],
  [/\beval\s*\(|\bnew\s+Function\s*\(/, 'eval / new Function'],
]

function scanColour(text: string, file: string, out: LintFinding[]): void {
  // A hex colour anywhere (CSS, an inline style, a JS string): #abc, #abcd, #aabbcc, #aabbccdd.
  const hex = /(^|[^&\w])#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])/g
  let m: RegExpExecArray | null
  while ((m = hex.exec(text)) !== null) {
    const at = m.index + (m[1]?.length ?? 0)
    out.push({ file, line: lineOf(text, at), rule: 'colour', text: `hard-coded colour #${m[2]}: use a token, e.g. var(--primary), var(--on-bg), var(--s-high)` })
  }
  const fn = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/gi
  while ((m = fn.exec(text)) !== null) {
    out.push({ file, line: lineOf(text, m.index), rule: 'colour', text: `hard-coded colour ${m[1]}(...): use a token (color-mix(in srgb, var(--primary) 20%, transparent) for a tint)` })
  }
  // A named colour as the value of a colour property, in CSS or set from JS (style.color = 'red', setProperty).
  const prop = new RegExp(`(?:^|[\\s;{"'\`])${COLOR_PROPS}\\s*[:=]\\s*["'\`]?([^;}"'\`\\n]*)`, 'gi')
  while ((m = prop.exec(text)) !== null) {
    const value = m[1] ?? ''
    for (const word of value.toLowerCase().match(/[a-z]+/g) ?? []) {
      if (NAMED.has(word) && !/var\(--[a-z0-9-]*$/i.test(value.slice(0, value.toLowerCase().indexOf(word)))) {
        out.push({ file, line: lineOf(text, m.index), rule: 'colour', text: `named colour "${word}": use a token, e.g. var(--on-bg)` })
        break
      }
    }
  }
  const camel = /\.(?:color|background|backgroundColor|borderColor|fill|stroke|outlineColor)\s*=\s*["'`]\s*([a-z]+)\s*["'`]/gi
  while ((m = camel.exec(text)) !== null) {
    if (NAMED.has((m[1] ?? '').toLowerCase())) out.push({ file, line: lineOf(text, m.index), rule: 'colour', text: `named colour "${m[1]}": use a token` })
  }
  // SVG paint attributes in markup or JS: fill="..." / stroke="..." must be none, currentColor or a var().
  const paint = /\b(fill|stroke|stop-color)\s*=\s*["']([^"']*)["']/gi
  while ((m = paint.exec(text)) !== null) {
    const value = (m[2] ?? '').trim()
    if (value === '' || /^(none|currentColor|transparent|inherit)$/i.test(value) || /^var\(--[a-z0-9-]+\)$/i.test(value) || /^url\(#[\w-]+\)$/.test(value) || /^\$\{/.test(value)) continue
    out.push({ file, line: lineOf(text, m.index), rule: 'colour', text: `${m[1]}="${value}": draw in currentColor or a token (fill="var(--primary)")` })
  }
}

function scanCssRules(text: string, file: string, out: LintFinding[]): void {
  let m: RegExpExecArray | null
  const family = /(?:^|[\s;{"'])font-family\s*:\s*([^;}"\n]*)/gi
  while ((m = family.exec(text)) !== null) {
    const value = (m[1] ?? '').trim()
    if (!/^(var\(--font\)|inherit|monospace|ui-monospace)$/i.test(value)) out.push({ file, line: lineOf(text, m.index), rule: 'font', text: `font-family: ${value}: use var(--font) (or inherit, or monospace for figures)` })
  }
  const shorthand = /(?:^|[\s;{"'])font\s*:\s*([^;}"\n]*)/gi
  while ((m = shorthand.exec(text)) !== null) {
    const value = (m[1] ?? '').trim()
    if (!/var\(--font\)|^inherit$|monospace\s*$/i.test(value)) out.push({ file, line: lineOf(text, m.index), rule: 'font', text: `font: ${value}: the family must be var(--font)` })
  }
  const radius = /(?:^|[\s;{"'])border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius\s*:\s*([^;}"\n]*)/gi
  while ((m = radius.exec(text)) !== null) {
    const value = (m[1] ?? '').trim()
    const parts = value.split(/\s+|\//).filter(Boolean)
    const ok = parts.every((part) => /^(0|0px|50%|999px|9999px|inherit|var\(--r-(sm|md|lg|xl)\))$/.test(part))
    if (!ok) out.push({ file, line: lineOf(text, m.index), rule: 'radius', text: `border-radius: ${value}: use var(--r-sm), var(--r-md), var(--r-lg), var(--r-xl), 999px (pill) or 50%` })
  }
  const fontFace = /@font-face/i.exec(text)
  if (fontFace !== null) out.push({ file, line: lineOf(text, fontFace.index), rule: 'font', text: '@font-face: the app font is already there as var(--font)' })
}

/** agent.call('tool', ...) names in code: each must be in the app's permissions. */
export function calledTools(text: string): string[] {
  const found = new Set<string>()
  const re = /\bagent\s*\.\s*call\s*\(\s*["'`]([a-z_][a-z0-9_]*)["'`]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) found.add(m[1] ?? '')
  return [...found]
}

export interface MiniAppDraft {
  name: string
  description: string
  icon: string
  files: Record<string, string>
  permissions: string[]
  subscribe: string[]
  refreshMinutes: number
}

/**
 * Everything wrong with an app, or nothing. A save is refused on any finding: the agent fixes it and saves again.
 * `knownTools` (when given) is every tool name that exists, so a permission for a tool that does not exist is caught.
 */
export function lintMiniApp(draft: MiniAppDraft, knownTools?: ReadonlySet<string>): LintFinding[] {
  const out: LintFinding[] = []
  const name = draft.name.trim()
  if (name === '' || name.length > 40) out.push({ file: 'manifest', line: 0, rule: 'manifest', text: 'name: 1 to 40 characters' })
  if (draft.description.length > 200) out.push({ file: 'manifest', line: 0, rule: 'manifest', text: 'description: at most 200 characters' })
  const iconWhy = checkIcon(draft.icon)
  if (iconWhy !== null) out.push({ file: 'manifest', line: 0, rule: 'icon', text: iconWhy })
  if (!Number.isInteger(draft.refreshMinutes) || draft.refreshMinutes < 0 || draft.refreshMinutes > 1440) out.push({ file: 'manifest', line: 0, rule: 'manifest', text: 'refreshMinutes: 0 to 1440' })

  for (const permission of draft.permissions) {
    const tool = toolOf(permission)
    if (!grantable(tool)) out.push({ file: 'manifest', line: 0, rule: 'permission', text: `${tool} can never be given to a mini-app` })
    else if (knownTools !== undefined && !knownTools.has(tool)) out.push({ file: 'manifest', line: 0, rule: 'permission', text: `${tool} is not a tool here` })
    else if ((tool === 'apps_run' || tool === 'webapp_run') && permission === tool) out.push({ file: 'manifest', line: 0, rule: 'permission', text: `${tool} needs what it may run: "${tool}:${tool === 'apps_run' ? 'SLUG' : 'app/tool'}"` })
  }
  for (const topic of draft.subscribe) {
    if (!topicAllowed(draft, topic)) out.push({ file: 'manifest', line: 0, rule: 'permission', text: `subscribe "${topic}": not a topic, or it needs a read permission it does not have (data.task needs task_list, calendar.changed needs calendar_events, worker.<id> needs worker_events)` })
  }

  const names = Object.keys(draft.files)
  if (!names.includes('index.html')) out.push({ file: 'index.html', line: 0, rule: 'file', text: 'an app needs index.html' })
  if (names.length > MINIAPP_MAX_FILES) out.push({ file: 'manifest', line: 0, rule: 'file', text: `at most ${MINIAPP_MAX_FILES} files` })
  let bytes = 0
  const perms = new Set(draft.permissions.map(toolOf))
  for (const file of names) {
    const text = draft.files[file] ?? ''
    bytes += text.length
    if (!FILE_NAME.test(file)) {
      out.push({ file, line: 0, rule: 'file', text: 'file names are letters, digits, . _ - and end in .html, .js, .css, .svg or .json (no folders)' })
      continue
    }
    const kind = file.endsWith('.css') ? 'css' : file.endsWith('.js') ? 'js' : file.endsWith('.json') ? 'json' : 'html'
    if (kind === 'json') {
      try {
        JSON.parse(text)
      } catch {
        out.push({ file, line: 0, rule: 'file', text: 'not valid JSON' })
      }
      continue
    }
    // The SVG namespace is a name, not an address: inline <svg xmlns="http://www.w3.org/2000/svg"> is fine.
    const clean = stripComments(stripComments(text, kind === 'html' ? 'html' : kind), kind === 'html' ? 'css' : kind).replace(/https?:\/\/www\.w3\.org\/[\w/.#-]*/g, (m) => ' '.repeat(m.length))
    scanColour(clean, file, out)
    if (kind !== 'js') scanCssRules(clean, file, out)
    else scanCssRules(clean.replace(/fontFamily\s*=/g, 'font-family:').replace(/borderRadius\s*=/g, 'border-radius:'), file, out)
    for (const [re, what] of NETWORK) {
      const m = re.exec(clean)
      if (m !== null) out.push({ file, line: lineOf(clean, m.index), rule: 'network', text: `${what}` })
    }
    for (const [re, what] of ESCAPES) {
      const m = re.exec(clean)
      if (m !== null) out.push({ file, line: lineOf(clean, m.index), rule: 'escape', text: what })
    }
    if (kind === 'html') {
      const src = /<\s*(?:script|link|img|audio|video|source)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi
      let m: RegExpExecArray | null
      while ((m = src.exec(clean)) !== null) {
        const ref = (m[1] ?? '').replace(/^\.\//, '').replace(/^\//, '')
        if (ref.startsWith('data:') || ref.startsWith('_agent/') || ref.startsWith('#')) continue
        if (!names.includes(ref)) out.push({ file, line: lineOf(clean, m.index), rule: 'file', text: `${ref} is not one of its files` })
      }
    }
    for (const tool of calledTools(clean)) {
      if (!perms.has(tool)) out.push({ file, line: 0, rule: 'permission', text: `agent.call('${tool}') but ${tool} is not in its permissions` })
    }
  }
  if (bytes > MINIAPP_MAX_BYTES) out.push({ file: 'manifest', line: 0, rule: 'file', text: `its files come to ${bytes} characters; at most ${MINIAPP_MAX_BYTES}` })
  return out
}

/** Findings as lines an agent can act on. */
export function lintReport(findings: LintFinding[], max = 25): string {
  const lines = findings.slice(0, max).map((f) => `- ${f.file}${f.line > 0 ? `:${f.line}` : ''} [${f.rule}] ${f.text}`)
  if (findings.length > max) lines.push(`- ...and ${findings.length - max} more`)
  return lines.join('\n')
}

// ---- versions --------------------------------------------------------------------------------------------------------

export function versionOf(app: MiniAppRow, by: string, reason: string, at: number): MiniAppVersion {
  return {
    n: app.version,
    at,
    by,
    reason,
    name: app.name,
    description: app.description,
    icon: app.icon,
    files: { ...app.files },
    permissions: [...app.permissions],
    subscribe: [...app.subscribe],
    refreshMinutes: app.refreshMinutes,
  }
}

/** The history after one more save: the version being replaced goes on the end, the oldest fall off. */
export function pushHistory(history: MiniAppVersion[], replaced: MiniAppVersion): MiniAppVersion[] {
  return [...history, replaced].slice(-MINIAPP_KEEP_VERSIONS)
}

/** Applies exact-text edits to files ({file, old, new}); each old must be found exactly once. */
export function applyPatches(files: Record<string, string>, patches: Array<{ file: string; old: string; new: string }>): { ok: true; files: Record<string, string> } | { ok: false; why: string } {
  const next = { ...files }
  for (const patch of patches) {
    const text = next[patch.file]
    if (text === undefined) return { ok: false, why: `${patch.file} is not one of its files` }
    const count = patch.old === '' ? 0 : text.split(patch.old).length - 1
    if (count !== 1) return { ok: false, why: `In ${patch.file} the old text was found ${count} times; it must be found exactly once` }
    next[patch.file] = text.replace(patch.old, () => patch.new)
  }
  return { ok: true, files: next }
}

// ---- pinning --------------------------------------------------------------------------------------------------------

/** The apps on the sidebar, in their order. */
export function pinnedApps<T extends Pick<MiniAppRow, 'pinned' | 'name'>>(apps: T[]): T[] {
  return apps.filter((app) => app.pinned > 0).sort((a, b) => a.pinned - b.pinned || a.name.localeCompare(b.name))
}

/**
 * The pin numbers after moving `id` to `position` (1 = first) among the pinned (or pinning it there). Numbers are
 * 1..n so they read as places. Returns every app whose number changes.
 */
export function repin<T extends Pick<MiniAppRow, 'id' | 'pinned' | 'name'>>(apps: T[], id: string, position: number | null): Array<{ id: string; pinned: number }> {
  const order = pinnedApps(apps).map((app) => app.id).filter((other) => other !== id)
  if (position !== null) {
    const at = Math.max(0, Math.min(order.length, Math.round(position) - 1))
    order.splice(at, 0, id)
  }
  const changes: Array<{ id: string; pinned: number }> = []
  const target = new Map(order.map((other, index) => [other, index + 1]))
  for (const app of apps) {
    const next = target.get(app.id) ?? 0
    if (next !== app.pinned) changes.push({ id: app.id, pinned: next })
  }
  return changes
}

/**
 * What search (Ctrl+K) finds a mini-app by: its name first, the other names it was given, then its one-line
 * description, and the words "app" and "mini-app" lightly, so "apps" alone lists them all. Same weights as a project.
 */
export function miniAppFields(app: Pick<MiniAppRow, 'name' | 'description'> & { aliases?: unknown }): Array<{ text: string; weight: number; fuzzy?: boolean }> {
  // A synced row from an older or newer build could carry anything here, so only strings count.
  const aliases = Array.isArray(app.aliases) ? app.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.trim() !== '') : []
  return [
    { text: app.name, weight: 1 },
    ...aliases.map((alias) => ({ text: alias, weight: 0.95 })),
    { text: app.description, weight: 0.6, fuzzy: false },
    { text: 'app apps mini-app', weight: 0.3, fuzzy: false },
  ]
}
