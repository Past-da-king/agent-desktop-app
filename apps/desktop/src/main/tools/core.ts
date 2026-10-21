/**
 * The everyday tools, ported from reference/phone/tools/CoreTools.kt (plus the report card from
 * ReportTool.kt): the clock, asking the person, asking permission, notifying, fetching a page and
 * putting a long answer in a report.
 */
import { lookup } from 'node:dns/promises'

import {
  int,
  isLoopback,
  schema,
  str,
  strList,
  type Tool,
} from '@agent/core'

import type { DataStore } from '../runtime/data'
import { formatDateTime } from '../runtime/time'
import { hasRefusal, NO, TURNED_DOWN, withNo } from '../../shared/ask-options'

export const FETCH_TIMEOUT_MS = 20_000
export const FETCH_MAX_CHARS = 12_000
const FETCH_MIN_CHARS = 200
const MAX_REDIRECTS = 5
const USER_AGENT = 'Mozilla/5.0 (compatible; AgentDesktop/0.1; +https://example.invalid/agent)'

export interface CoreToolDeps {
  store: DataStore
  /** Tests pin the clock; production uses the real one. */
  now?: () => Date
  fetchImpl?: typeof fetch
  /** Loopback is allowed by default (a local fake server in tests); private networks never are. */
  allowLoopback?: boolean
  timeoutMs?: number
}

export function coreTools(deps: CoreToolDeps): Tool[] {
  return [
    nowTool(deps),
    askUserTool(),
    requestApprovalTool(),
    notifyUserTool(),
    webFetchTool(deps),
    reportTool(deps.store),
  ]
}

function nowTool(deps: CoreToolDeps): Tool {
  return {
    spec: {
      name: 'now',
      description: 'The current date, time and timezone on the computer.',
      schema: schema([], {}),
    },
    run: async () => formatDateTime((deps.now ?? (() => new Date()))()),
  }
}

function askUserTool(): Tool {
  return {
    spec: {
      name: 'ask_user',
      description:
        'Ask the user a question with tappable answer buttons and wait for the reply. Use for real choices only; do the rest yourself.',
      schema: schema(
        ['question', 'options'],
        {
          question: str('The question, one short line'),
          options: strList('2 to 4 short button labels'),
        },
      ),
    },
    run: async (input, ctx) => {
      const given = strings(input['options'])
      const options = given.length === 0 ? ['Yes', 'No'] : given
      // There is always a way to say no, last (the owner's rule on the phone, agent/AskOptions.kt).
      const answer = await ctx.ask(text(input['question']), withNo(options))
      if (answer === null) {
        return 'Nobody could answer right now (this is a background run). Make the safe choice or leave it for the user.'
      }
      if (answer === NO && !hasRefusal(options)) return TURNED_DOWN
      return `The user answered: ${answer}`
    },
  }
}

function requestApprovalTool(): Tool {
  return {
    spec: {
      name: 'request_approval',
      description:
        'Ask the user to approve something that changes the outside world (sending, buying, deleting, running a command) and wait for their decision. Pass the exact content they are approving.',
      schema: schema(['summary'], {
        summary: str('One line saying exactly what will happen'),
        details: str('The exact content, command or list that will go out'),
      }),
    },
    run: async (input, ctx) => {
      const summary = text(input['summary']).trim()
      if (summary === '') return 'Describe what you are asking to do in summary.'
      const approved = await ctx.approve(summary, text(input['details']).trim() || undefined)
      return approved ? 'The user approved.' : 'The user declined.'
    },
  }
}

function notifyUserTool(): Tool {
  return {
    spec: {
      name: 'notify_user',
      description:
        'Send the user a notification. Use for the result of background work or anything time-sensitive.',
      schema: schema(['title', 'body'], {
        title: str('Short title'),
        body: str('One or two lines'),
      }),
    },
    run: async (input, ctx) => {
      await ctx.notify(text(input['title']), text(input['body']))
      return 'Notified.'
    },
  }
}

function reportTool(store: DataStore): Tool {
  return {
    spec: {
      name: 'report',
      description:
        'Put a long answer in a REPORT instead of the chat: research, comparisons, plans, write-ups. It shows as a card the user taps to read beside the chat, share or save. In the chat you then say only the one-line takeaway. The report is drawn with OpenUI like your chat replies: write the reasoning as markdown and draw its structured parts as ```openui-lang blocks between the paragraphs (a Table for a comparison, a BarChart or LineChart for numbers, Steps for a plan, a Callout for the key finding or risk, a ListBlock of sources with @OpenUrl). A markdown table is drawn as a table card too.',
      schema: schema(['title', 'markdown'], {
        title: str("Short title, e.g. 'Cyber tender readiness'"),
        markdown: str('The full report: markdown (headings, short paragraphs, [links](https://...) to sources) with ```openui-lang blocks for tables, charts, steps and callouts'),
      }),
    },
    run: async (input) => {
      const title = text(input['title']).trim().slice(0, 80) || 'Report'
      const markdown = text(input['markdown']).trim()
      if (markdown === '') return 'The report is empty. Pass the full text in markdown.'
      const words = markdown.split(/\s+/).filter((word) => word !== '').length
      await store.upsert('chat_item', {
        kind: 'report',
        text: title,
        meta: JSON.stringify({ title, markdown, words }),
      })
      return 'The report card is in the chat. Now say only the one-line takeaway; do not repeat the report.'
    },
  }
}

function webFetchTool(deps: CoreToolDeps): Tool {
  const call = deps.fetchImpl ?? fetch
  const allowLoopback = deps.allowLoopback ?? true
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS

  return {
    spec: {
      name: 'web_fetch',
      description:
        'Fetch a web address over HTTP and return its text (HTML is stripped). Fast, for pages and APIs that do not need JavaScript or a sign-in. It cannot reach this computer\'s network.',
      schema: schema(['url'], {
        url: str('An https:// web address'),
        maxChars: int('How much text to return, at most 12000 characters'),
      }),
    },
    run: async (input, ctx) => {
      const raw = text(input['url']).trim()
      if (raw === '') return 'Pass the web address to fetch.'
      let url: URL
      try {
        url = new URL(raw)
      } catch {
        return 'That is not a valid web address.'
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return 'Only web addresses (https://) can be fetched.'
      }

      const limit = clamp(number(input['maxChars'], FETCH_MAX_CHARS), FETCH_MIN_CHARS, FETCH_MAX_CHARS)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const onAbort = (): void => controller.abort()
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      try {
        return await fetchWithChecks(url, call, controller.signal, { allowLoopback, limit })
      } finally {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
      }
    },
  }
}

interface FetchChecks {
  allowLoopback: boolean
  limit: number
}

async function fetchWithChecks(
  start: URL,
  call: typeof fetch,
  signal: AbortSignal,
  checks: FetchChecks,
): Promise<string> {
  let current = start
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const blocked = await blockedReason(current, checks.allowLoopback)
    if (blocked !== null) return blocked

    let response: Response
    try {
      response = await call(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8',
        },
      })
    } catch {
      if (signal.aborted) return 'The page took too long to answer, or I stopped reading it.'
      return `Could not reach ${current.hostname}.`
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (location === null || location === '') {
        return `HTTP ${response.status}\nThe page redirected without saying where.`
      }
      try {
        current = new URL(location, current)
      } catch {
        return 'The page redirected to an address I cannot read.'
      }
      continue
    }

    const type = (response.headers.get('content-type') ?? '').toLowerCase()
    if (type !== '' && !/text\/|html|json|xml|javascript|urlencoded/.test(type)) {
      return `That address is a ${type.split(';')[0] ?? type} file, not text I can read.`
    }

    let body: string
    try {
      body = await response.text()
    } catch {
      if (signal.aborted) return 'The page took too long to answer, or I stopped reading it.'
      return 'The page started answering and then stopped.'
    }
    const readable = type.includes('html') ? htmlToText(body) : body
    return `HTTP ${response.status}\n${clip(readable, checks.limit)}`
  }
  return 'That address redirected too many times.'
}

/** Null when the address may be fetched; otherwise a line the model can pass on. */
async function blockedReason(url: URL, allowLoopback: boolean): Promise<string | null> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const loopback = isLoopback(url.toString())
  const literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')

  if (loopback && !allowLoopback) return 'That address is this computer, which is not allowed here.'
  if (literal && !addressAllowed(host, allowLoopback)) {
    return 'That address is on a private network, so I will not fetch it.'
  }
  if (url.protocol === 'http:' && !loopback) {
    return 'Plain http is only fetched from this computer. Use an https:// address.'
  }
  if (literal) return null

  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true, verbatim: true })
  } catch {
    return `I could not find ${host}.`
  }
  if (addresses.length === 0) return `I could not find ${host}.`
  for (const entry of addresses) {
    if (!addressAllowed(entry.address, allowLoopback)) {
      return 'That address is on a private network, so I will not fetch it.'
    }
  }
  return null
}

/** Loopback may be allowed; private, link-local and unspecified addresses never are. */
export function addressAllowed(address: string, allowLoopback = true): boolean {
  const clean = address.trim().toLowerCase().replace(/^::ffff:/, '')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(clean)) {
    const parts = clean.split('.').map((part) => Number(part))
    const a = parts[0] ?? -1
    const b = parts[1] ?? -1
    if (a === 127) return allowLoopback
    if (a === 0 || a === 10 || a === 255) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 169 && b === 254) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    return true
  }
  if (clean === '::1') return allowLoopback
  if (clean === '::' || clean === '') return false
  if (clean.startsWith('fc') || clean.startsWith('fd')) return false
  if (/^fe[89ab]/.test(clean)) return false
  return true
}

/** Readable text from a page, ported from WebFetchTool.htmlToText in CoreTools.kt. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n\n+/g, '\n\n')
    .trim()
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...(cut, ${text.length} characters in all)`
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
