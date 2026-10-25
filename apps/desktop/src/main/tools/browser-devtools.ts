/**
 * Developer tools for the agent's own browser, like a person pressing Ctrl+Shift+I: the network log
 * (to discover a site's API), replaying a request from inside the page, the console with uncaught errors,
 * inspecting elements, and cookies and storage. Running code in the page is browser_eval (browser-pro).
 *
 * Every tab records from the moment it opens (browser/devtools.ts). Every output here is capped so one
 * call cannot flood the context.
 */
import { bool, enumOf, int, schema, str, type JsonObject, type Tool } from '@agent/core'

import type { TabDevtools } from '../browser/devtools'
import { fetchScript, inspectScript, storageScript } from '../browser/devtools'
import {
  CONSOLE_LEVELS,
  cap,
  filterConsole,
  filterNetwork,
  formatConsole,
  formatHeaders,
  formatNetworkEntry,
  formatNetworkList,
  isTextMime,
  sizeLabel,
  statusMatcher,
} from '../browser/devtools-log'
import { checkBrowserUrl } from '../browser/url-policy'
import { parseHeaders } from './browser-pro'
import { guardBrowserTool } from '../browser/deadline'

export interface BrowserDevtoolsDeps {
  /** The developer tools of the agent's current tab, or null when it has no page yet. */
  devtools: () => Promise<TabDevtools | null>
}

const NO_PAGE = 'No page is open in your browser yet. Use browser_open first.'
const MAX_OUT = 20_000
const DEFAULT_STYLES = [
  'display',
  'visibility',
  'opacity',
  'position',
  'z-index',
  'pointer-events',
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'width',
  'height',
  'overflow',
]
/** Headers a page cannot set on fetch, or that the browser fills in itself. */
const NOT_REPLAYED = /^(:|sec-|proxy-)|^(cookie|cookie2|host|origin|referer|content-length|connection|keep-alive|accept-encoding|accept-charset|user-agent|transfer-encoding|te|trailer|upgrade|expect|date|dnt|via|access-control-request-headers|access-control-request-method|permissions-policy)$/i

export function browserDevtoolsTools(deps: BrowserDevtoolsDeps): Tool[] {
  return [networkTool(deps), networkGetTool(deps), fetchTool(deps), consoleTool(deps), inspectTool(deps), storageTool(deps)].map(guardBrowserTool)
}

function networkTool(deps: BrowserDevtoolsDeps): Tool {
  return {
    spec: {
      name: 'browser_network',
      description:
        "The requests your current tab made since it opened (always recording, like the DevTools Network panel). Use it to discover a site's API: api=true keeps only XHR and fetch calls; filter by a word in the url, method, type or status (200, 4xx, error, failed). Then browser_network_get with an id shows headers and body. clear empties the log, so the next list shows only what your next action sends.",
      schema: schema([], {
        url: str('Only requests whose address contains this'),
        method: str('GET, POST...'),
        type: str('Resource type: xhr, fetch, document, script, stylesheet, image, font, media, websocket, other'),
        status: str('200, 404, 2xx, 4xx, error (400 and up or failed), failed, pending'),
        api: bool('Only the page\'s own XHR and fetch calls'),
        limit: int('How many of the newest to show, default 40, at most 200'),
        clear: bool('Empty the log instead of listing'),
      }),
    },
    run: async (input) =>
      withTab(deps, async (tab) => {
        if (input['clear'] === true) {
          tab.network.clear()
          return 'Cleared. Do the action in the page, then list again.'
        }
        const status = text(input['status'])
        if (statusMatcher(status) === null) return 'status is a code like 200, a range like 4xx, error, failed or pending.'
        const all = tab.network.all()
        const matches = filterNetwork(all, {
          url: text(input['url']),
          method: text(input['method']),
          type: text(input['type']),
          status,
          api: input['api'] === true,
        })
        return cap(formatNetworkList(matches, { limit: number(input['limit']) ?? 40, total: all.length }), MAX_OUT)
      }),
  }
}

function networkGetTool(deps: BrowserDevtoolsDeps): Tool {
  return {
    spec: {
      name: 'browser_network_get',
      description:
        'Everything about one recorded request (its id from browser_network): request headers and body, status, response headers, timing, and the response body (text, or binary named and sized).',
      schema: schema(['id'], {
        id: str('The request id, for example r12'),
        body: bool('Include the response body (default true)'),
        max: int('Most characters of the body to show, default 6000, at most 30000'),
      }),
    },
    run: async (input) =>
      withTab(deps, async (tab) => {
        const id = text(input['id']).trim()
        if (id === '') return 'Pass the id from browser_network, for example r12.'
        const entry = tab.network.get(id)
        if (entry === null) return `No recorded request ${id}. It may have been cleared or pushed out by newer ones; list again with browser_network.`
        const max = clamp(number(input['max']) ?? 6_000, 200, 30_000)
        const requestBody = await tab.requestBody(entry)
        const wantBody = input['body'] !== false
        const response = wantBody ? await tab.responseBody(entry, max) : { body: null, note: '' }
        return cap(formatNetworkEntry(entry, { requestBody, responseBody: response.body, bodyNote: response.note, maxBody: max }), MAX_OUT + max)
      }),
  }
}

function fetchTool(deps: BrowserDevtoolsDeps): Tool {
  return {
    spec: {
      name: 'browser_fetch',
      description:
        "Send an HTTP request from inside your current page (the page's own fetch), so its cookies, sign-in and origin apply. Use it to try an API found with browser_network: from replays a recorded request, and anything else you pass overrides it. Another site's API must allow CORS. Returns status, headers and the body.",
      schema: schema([], {
        from: str('A request id from browser_network to replay'),
        url: str('Address; a path like /api/items is relative to the page'),
        method: str('GET (default), POST, PUT, PATCH, DELETE, HEAD'),
        headers: { type: 'object', description: 'Request headers, {"content-type": "application/json"}' },
        body: str('Request body; JSON as text'),
        max: int('Most characters of the body to show, default 6000, at most 30000'),
        seconds: int('How long to wait, default 20, at most 60'),
      }),
    },
    run: async (input) =>
      withTab(deps, async (tab) => {
        const fromId = text(input['from']).trim()
        const base = fromId === '' ? null : tab.network.get(fromId)
        if (fromId !== '' && base === null) return `No recorded request ${fromId}. List them with browser_network.`
        const pageUrl = tab.url()
        const rawUrl = text(input['url']).trim() || (base?.url ?? '')
        if (rawUrl === '') return 'Pass a url, or from with a recorded request id.'
        let target: URL
        try {
          target = new URL(rawUrl, pageUrl === '' ? undefined : pageUrl)
        } catch {
          return 'That is not a web address.'
        }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') return 'Only http and https addresses.'
        // The page's own site is always fine (that is the point); anywhere else follows the browser's rules.
        if (!sameOrigin(target, pageUrl)) {
          const policy = checkBrowserUrl(target.toString())
          if (!policy.ok) return policy.reason
        }
        const method = (text(input['method']).trim() || base?.method || 'GET').toUpperCase()
        if (!/^[A-Z]{3,10}$/.test(method)) return 'method is GET, POST, PUT, PATCH, DELETE or HEAD.'
        const headers: Record<string, string> = {}
        if (base !== null) {
          for (const [key, value] of Object.entries(base.requestHeaders)) if (!NOT_REPLAYED.test(key)) headers[key] = value
        }
        const given = headersInput(input['headers'])
        if (given === null) return 'headers is an object like {"content-type": "application/json"}.'
        for (const [key, value] of Object.entries(given)) {
          for (const existing of Object.keys(headers)) if (existing.toLowerCase() === key.toLowerCase()) delete headers[existing]
          headers[key] = value
        }
        let body: string | null = null
        if (input['body'] !== undefined && input['body'] !== null) {
          body = typeof input['body'] === 'string' ? input['body'] : JSON.stringify(input['body'])
        } else if (base !== null && base.hasPostData) {
          body = await tab.requestBody(base)
        }
        if (body !== null && body.length > 200_000) return 'That body is too long.'
        const max = clamp(number(input['max']) ?? 6_000, 200, 30_000)
        const seconds = clamp(number(input['seconds']) ?? 20, 1, 60)
        const result = await tab.evaluate(fetchScript({ url: target.toString(), method, headers, body, maxChars: max, timeoutMs: seconds * 1000 }))
        if (!result.ok) return `The request could not be made: ${cap(result.error, 1_500)}`
        return formatFetch(asObject(result.value), method, target.toString(), max)
      }),
  }
}

function consoleTool(deps: BrowserDevtoolsDeps): Tool {
  return {
    spec: {
      name: 'browser_console',
      description:
        "Your current tab's console since it opened: console messages, uncaught errors and promise rejections with their stack, and the browser's own warnings (failed loads, blocked content). level error shows only errors, warning shows warnings and errors. clear empties it.",
      schema: schema([], {
        level: enumOf('Lowest level to show', 'all', ...CONSOLE_LEVELS),
        text: str('Only messages containing this'),
        limit: int('How many of the newest, default 50, at most 200'),
        clear: bool('Empty the console instead of listing'),
      }),
    },
    run: async (input) =>
      withTab(deps, async (tab) => {
        if (input['clear'] === true) {
          await tab.clearConsole()
          return 'Console cleared.'
        }
        const all = tab.console.all()
        const matches = filterConsole(all, { level: text(input['level']), text: text(input['text']) })
        if (matches === null) return `level is all, ${CONSOLE_LEVELS.join(', ')}.`
        return formatConsole(matches, { limit: number(input['limit']) ?? 50, total: all.length, maxChars: MAX_OUT })
      }),
  }
}

function inspectTool(deps: BrowserDevtoolsDeps): Tool {
  return {
    spec: {
      name: 'browser_inspect',
      description:
        'Inspect elements by CSS selector, like the DevTools Elements panel: how many match, and for each its tag, attributes, position and size, whether it is visible, its text, outerHTML and computed styles (styles picks which).',
      schema: schema(['selector'], {
        selector: str('CSS selector, for example form button[type=submit]'),
        limit: int('How many elements to show, default 5, at most 20'),
        styles: str('Computed style properties to read, comma separated; a sensible set by default'),
        html: int('Most characters of outerHTML per element, default 1500, at most 8000'),
      }),
    },
    run: async (input) =>
      withTab(deps, async (tab) => {
        const selector = text(input['selector']).trim()
        if (selector === '') return 'Pass a CSS selector.'
        if (selector.length > 2_000) return 'That selector is too long.'
        const asked = text(input['styles'])
          .split(',')
          .map((part) => part.trim().toLowerCase())
          .filter((part) => /^-?[a-z][a-z0-9-]*$/.test(part))
          .slice(0, 40)
        const styles = asked.length > 0 ? asked : DEFAULT_STYLES
        const limit = clamp(number(input['limit']) ?? 5, 1, 20)
        const htmlMax = clamp(number(input['html']) ?? 1_500, 100, 8_000)
        const result = await tab.evaluate(inspectScript(selector, limit, styles, htmlMax))
        if (!result.ok) return `Could not inspect: ${cap(result.error, 1_000)}`
        return cap(formatInspect(selector, asObject(result.value)), MAX_OUT)
      }),
  }
}

function storageTool(deps: BrowserDevtoolsDeps): Tool {
  return {
    spec: {
      name: 'browser_storage',
      description:
        "Cookies (httpOnly ones too, with their flags), localStorage and sessionStorage of your current page's site, like the DevTools Application panel. Values may be secret: use them, but never repeat them to the user or put them in a saved tool.",
      schema: schema([], {
        what: enumOf('What to read, default all', 'all', 'cookies', 'local', 'session'),
        name: str('Only cookies or keys whose name contains this'),
        max: int('Most characters per value, default 300, at most 4000'),
      }),
    },
    run: async (input) =>
      withTab(deps, async (tab) => {
        const what = text(input['what']).trim() || 'all'
        if (!['all', 'cookies', 'local', 'session'].includes(what)) return 'what is all, cookies, local or session.'
        const name = text(input['name']).trim()
        const max = clamp(number(input['max']) ?? 300, 20, 4_000)
        const pageUrl = tab.url()
        const lines: string[] = [`Page: ${pageUrl}`]
        if (what === 'all' || what === 'cookies') {
          let cookies: Array<Record<string, unknown>> = []
          try {
            cookies = /^https?:/i.test(pageUrl) ? await tab.cookies([pageUrl]) : []
          } catch (error) {
            lines.push(`Cookies: could not be read (${error instanceof Error ? error.message : String(error)}).`)
          }
          const shown = cookies.filter((c) => name === '' || text(c['name']).toLowerCase().includes(name.toLowerCase()))
          lines.push('', `Cookies sent to this page (${shown.length}${shown.length === cookies.length ? '' : ` of ${cookies.length}`}):`)
          if (shown.length === 0) lines.push('  (none)')
          for (const c of shown.slice(0, 80)) lines.push(`  ${cookieLine(c, max)}`)
          if (shown.length > 80) lines.push(`  [${shown.length - 80} more]`)
        }
        if (what !== 'cookies') {
          const result = await tab.evaluate(storageScript({ local: what === 'all' || what === 'local', session: what === 'all' || what === 'session' }, name, max))
          if (!result.ok) {
            lines.push('', `Storage could not be read: ${cap(result.error, 500)}`)
          } else {
            const value = asObject(result.value)
            if (value['local'] !== null && value['local'] !== undefined) lines.push('', ...storageLines('localStorage', asObject(value['local'])))
            if (value['session'] !== null && value['session'] !== undefined) lines.push('', ...storageLines('sessionStorage', asObject(value['session'])))
          }
        }
        return cap(lines.join('\n'), MAX_OUT)
      }),
  }
}

// ---- formatting -----------------------------------------------------------------------------------

export function formatFetch(value: Record<string, unknown>, method: string, url: string, max: number): string {
  const ms = typeof value['ms'] === 'number' ? `${value['ms']} ms` : ''
  if (value['ok'] !== true) {
    return [
      `${method} ${url}`,
      `The request did not go through${ms === '' ? '' : ` (${ms})`}: ${text(value['error']) || 'unknown error'}.`,
      "A request to another site fails when that site does not allow CORS, and the page's content security policy can block it; browser_console shows the browser's reason.",
    ].join('\n')
  }
  const headers: Record<string, string> = {}
  for (const [key, raw] of Object.entries(asObject(value['headers']))) headers[key] = text(raw)
  const size = typeof value['size'] === 'number' ? value['size'] : 0
  const body = text(value['body'])
  const lines = [
    `${method} ${url}`,
    `${String(value['status'])} ${text(value['statusText'])}`.trim() +
      `   (${[ms, value['binary'] === true ? sizeLabel(size) : `${size} characters`, value['redirected'] === true ? `redirected to ${text(value['url'])}` : ''].filter((p) => p !== '').join(', ')})`,
    '',
    'Response headers (as the page sees them):',
    ...(Object.keys(headers).length === 0 ? ['  (none)'] : formatHeaders(headers)),
    '',
  ]
  if (method === 'HEAD') return lines.join('\n')
  if (value['binary'] === true) {
    lines.push(`Body: binary ${headers['content-type'] ?? ''}, ${sizeLabel(size)}; the first bytes in base64:`, body)
  } else if (size === 0) {
    lines.push('Body: empty.')
  } else {
    lines.push(`Body${isTextMime(headers['content-type'] ?? '') ? ` (${headers['content-type']})` : ''}:`, body)
    if (size > body.length) lines.push(`[cut: ${size - body.length} more characters; pass a bigger max to see more]`)
  }
  return cap(lines.join('\n'), MAX_OUT + max)
}

export function formatInspect(selector: string, value: Record<string, unknown>): string {
  if (typeof value['error'] === 'string') return value['error']
  const count = typeof value['count'] === 'number' ? value['count'] : 0
  const items = Array.isArray(value['items']) ? value['items'].map(asObject) : []
  if (count === 0) return `Nothing on the page matches ${selector}.`
  const lines = [`${count} element${count === 1 ? '' : 's'} match ${selector}${items.length < count ? `; the first ${items.length}` : ''}:`]
  items.forEach((item, position) => {
    const attributes = Object.entries(asObject(item['attributes']))
      .map(([key, raw]) => (text(raw) === '' ? key : `${key}="${text(raw)}"`))
      .join(' ')
    const box = asObject(item['box'])
    const where = `at ${String(box['x'])},${String(box['y'])} size ${String(box['width'])}x${String(box['height'])}${box['inViewport'] === true ? ' (in view)' : ' (scrolled out of view)'}`
    lines.push('', `[${position + 1}] <${text(item['tag'])}${attributes === '' ? '' : ` ${attributes}`}>`)
    lines.push(`  ${item['visible'] === true ? 'visible' : 'NOT visible'}, ${where}`)
    if (text(item['text']) !== '') lines.push(`  text: ${text(item['text'])}`)
    const styles = Object.entries(asObject(item['styles']))
      .map(([key, raw]) => `${key}: ${text(raw)}`)
      .join('; ')
    if (styles !== '') lines.push(`  styles: ${styles}`)
    lines.push(`  html: ${text(item['html'])}`)
  })
  return lines.join('\n')
}

function cookieLine(c: Record<string, unknown>, max: number): string {
  const value = text(c['value'])
  const shown = value.length > max ? `${value.slice(0, max)}... [${value.length - max} more characters]` : value
  const expires = typeof c['expires'] === 'number' && c['expires'] > 0 ? new Date(c['expires'] * 1000).toISOString().slice(0, 10) : 'session'
  const flags = [
    `domain ${text(c['domain'])}`,
    `path ${text(c['path'])}`,
    c['httpOnly'] === true ? 'httpOnly' : '',
    c['secure'] === true ? 'secure' : '',
    text(c['sameSite']) === '' ? '' : `SameSite ${text(c['sameSite'])}`,
    `expires ${expires}`,
  ].filter((p) => p !== '')
  return `${text(c['name'])}=${shown}  (${flags.join(', ')})`
}

function storageLines(label: string, value: Record<string, unknown>): string[] {
  if (typeof value['error'] === 'string') return [`${label}: ${value['error']}`]
  const count = typeof value['count'] === 'number' ? value['count'] : 0
  const items = Array.isArray(value['items']) ? value['items'].map(asObject) : []
  if (count === 0) return [`${label}: empty`]
  const lines = [`${label} (${count} key${count === 1 ? '' : 's'}, ${typeof value['bytes'] === 'number' ? value['bytes'] : 0} characters)${items.length < count ? `, ${items.length} shown` : ''}:`]
  for (const item of items) lines.push(`  ${text(item['key'])} = ${text(item['value'])}`)
  if (typeof value['more'] === 'number' && value['more'] > 0) lines.push(`  [${value['more']} more]`)
  return lines
}

// ---- small helpers ------------------------------------------------------------------------------------

async function withTab(deps: BrowserDevtoolsDeps, action: (tab: TabDevtools) => Promise<string>): Promise<string> {
  try {
    const tab = await deps.devtools()
    if (tab === null) return NO_PAGE
    return await action(tab)
  } catch (error) {
    return `The browser had a problem: ${error instanceof Error ? error.message : String(error)}`
  }
}

function sameOrigin(target: URL, pageUrl: string): boolean {
  try {
    return new URL(pageUrl).origin === target.origin
  } catch {
    return false
  }
}

function headersInput(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{')) {
      try {
        return headersInput(JSON.parse(trimmed) as unknown)
      } catch {
        return null
      }
    }
    return parseHeaders(value)
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as JsonObject)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) return null
    out[key] = typeof raw === 'string' ? raw : JSON.stringify(raw)
  }
  return out
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
