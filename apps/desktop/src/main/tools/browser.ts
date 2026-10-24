/**
 * The browser tools. Names and wording follow reference/phone/tools/BrowserTools.kt, adapted to
 * numbered elements from the page outline instead of the phone's profile picker.
 */
import { bool, enumOf, int, schema, str, type Tool } from '@agent/core'

import { checkBrowserUrl } from '../browser/url-policy'
import { NO, TURNED_DOWN } from '../../shared/ask-options'
import type { BrowserDriver } from '../browser/types'

export interface BrowserToolDeps {
  browser: BrowserDriver
  /** The name the person gave their agent, for the handoff card. */
  agentName?: () => string
}

const MAX_TEXT = 8_000
const MAX_PATH = 4_096
const HANDOFF_DONE = 'Done, carry on'
/** What the app answers for the person when they close the tab they were handed (index.ts onHandoffClosed). */
export const HANDOFF_CLOSED = 'Closed the tab'
const HANDOFF_SKIP = 'Skip'

export function browserTools(deps: BrowserToolDeps): Tool[] {
  return [
    openTool(deps),
    closeTool(deps),
    lookTool(deps),
    readTool(deps),
    clickTool(deps),
    typeTool(deps),
    keyTool(deps),
    scrollTool(deps),
    waitTool(deps),
    backTool(deps),
    uploadTool(deps),
    handoffTool(deps),
    showUserTool(deps),
  ]
}

function openTool(deps: BrowserToolDeps): Tool {
  return {
    spec: {
      name: 'browser_open',
      description:
        "Open a web address in your own browser, shown in the panel beside the chat. Returns the page outline with numbered elements. The agent may only open normal web pages, never local files or this computer's network.",
      schema: schema(['url'], {
        url: str('URL or domain, for example example.com'),
        new_tab: bool('Open it in a new tab of your own and keep your current one open too'),
      }),
    },
    run: async (input) => {
      const raw = text(input['url']).trim()
      if (raw === '') return 'Pass the web address to open.'
      const policy = checkBrowserUrl(raw)
      if (!policy.ok) return policy.reason
      const browser = deps.browser
      if (input['new_tab'] === true && browser.openNewTab !== undefined) return call(() => browser.openNewTab!(policy.url))
      return call(() => browser.open(policy.url))
    },
  }
}

/**
 * Closing what you opened (24 Oct 2026). The app also closes a run's tabs when it ends; this is for closing as soon as
 * a page is done with, or a tab opened with new_tab.
 */
function closeTool(deps: BrowserToolDeps): Tool {
  return {
    spec: {
      name: 'browser_close',
      description:
        "Close your browser tab when you are done with it, so it stops using the computer's memory. No tab: the tab you are on; tab: one of your tabs by id; all: every tab you opened. The person's own tabs and tabs another agent is using are never closed. The app also closes your tabs when your run ends.",
      schema: schema([], {
        tab: str('Tab id, for example tab-3. Leave out for the tab you are on'),
        all: bool('Close every tab you opened'),
      }),
    },
    run: async (input) => {
      const browser = deps.browser
      if (browser.closeOwnTab === undefined) return 'This browser closes your tab by itself when your run ends.'
      const tab = text(input['tab']).trim()
      return call(() => browser.closeOwnTab!(tab === '' ? undefined : tab, input['all'] === true))
    },
  }
}

function lookTool(deps: BrowserToolDeps): Tool {
  return {
    spec: {
      name: 'browser_look',
      description:
        "Take a screenshot of the current page for YOURSELF to look at, when text is not enough: images, layouts, maps, charts, or a button you cannot find.",
      schema: schema([], {}),
    },
    run: async () => {
      const path = await deps.browser.screenshot()
      if (path === null) return 'Screenshot failed. Is a page open?'
      return `Here is the page:\n[[image:${path}]]`
    },
  }
}

function readTool(deps: BrowserToolDeps): Tool {
  return {
    spec: {
      name: 'browser_read',
      description:
        'Read the current page: by default its visible text, or a numbered element from the outline, or a CSS selector.',
      schema: schema([], {
        index: int('Element number from the outline'),
        selector: str('CSS selector'),
      }),
    },
    run: async (input) => {
      const index = optionalIndex(input['index'])
      if (index === 'bad') return 'Pass the number from the outline, or leave it out.'
      const selector = text(input['selector']).trim()
      return call(() =>
        deps.browser.read({
          ...(index === null ? {} : { index }),
          ...(selector === '' ? {} : { selector }),
        }),
      )
    },
  }
}

function clickTool(deps: BrowserToolDeps): Tool {
  return {
    spec: {
      name: 'browser_click',
      description:
        'Click an element by its [number] from the page outline, then return the new outline.',
      schema: schema(['index'], {
        index: int('Element number from the outline'),
      }),
    },
    run: async (input) => {
      const index = requiredIndex(input['index'])
      if (index === null) return 'Pass the number of the element from the outline.'
      return call(() => deps.browser.click(index))
    },
  }
}

function typeTool(deps: BrowserToolDeps): Tool {
  return {
    spec: {
      name: 'browser_type',
      description:
        'Type text into a field by its [number] from the outline. Set submit to press Enter afterwards.',
      schema: schema(['index', 'text'], {
        index: int('Element number from the outline'),
        text: str('What to type'),
        submit: bool('Press Enter after typing'),
      }),
    },
    run: async (input) => {
      const index = requiredIndex(input['index'])
      if (index === null) return 'Pass the number of the field from the outline.'
      const value = text(input['text'])
      if (value.length > MAX_TEXT) return 'That text is too long for one field.'
      return call(() => deps.browser.type(index, value, input['submit'] === true))
    },
  }
}

function keyTool(deps: BrowserToolDeps): Tool {
  return {
    spec: {
      name: 'browser_press_key',
      description: 'Press a key in the page: Enter, Tab or Escape, then return the new outline.',
      schema: schema(['key'], {
        key: enumOf('Key', 'Enter', 'Tab', 'Escape'),
      }),
    },
    run: async (input) => {
      const key = text(input['key']).trim()
      if (key !== 'Enter' && key !== 'Tab' && key !== 'Escape') {
        return 'Use Enter, Tab or Escape.'
      }
      return call(() => deps.browser.press(key))
    },
  }
}

function scrollTool(deps: BrowserToolDeps): Tool {
  return {
    spec: {
      name: 'browser_scroll',
      description: 'Scroll the page down, or up, one screen and return the new outline.',
      schema: schema([], {
        up: bool('Scroll up instead of down'),
      }),
    },
    run: async (input) => {
      const dy = input['up'] === true ? -600 : 600
      return call(() => deps.browser.scroll(dy))
    },
  }
}

function waitTool(deps: BrowserToolDeps): Tool {
  return {
    spec: {
      name: 'browser_wait_for',
      description:
        'Wait until the page shows some text or a selector, up to 30 seconds. Use it for slow pages and sign-in steps.',
      schema: schema([], {
        text: str('Text to wait for'),
        selector: str('CSS selector to wait for'),
        seconds: int('Max seconds, default 15'),
      }),
    },
    run: async (input, ctx) => {
      const wanted = text(input['text']).trim()
      const selector = text(input['selector']).trim()
      if (wanted === '' && selector === '') return 'Pass the text or selector to wait for.'
      const seconds = clamp(secondsArg(input['seconds']), 1, 30)
      return call(() => deps.browser.waitFor({ text: wanted, selector }, seconds, ctx.signal))
    },
  }
}

function backTool(deps: BrowserToolDeps): Tool {
  return {
    spec: {
      name: 'browser_back',
      description: 'Go back one page and return the new outline.',
      schema: schema([], {}),
    },
    run: async () => call(() => deps.browser.back()),
  }
}

/** A file that holds keys or secrets (an .env, a private key, a password store): uploading it asks first. */
export function secretFile(path: string): boolean {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  return /^[.]env([.]|$)|[.](env|pem|key|p12|pfx|kdbx|keychain|ppk|asc|gpg)$|^id_(rsa|dsa|ecdsa|ed25519)|credential|secret|password|passwd|api[ _-]?key|token/i.test(name)
}

function uploadTool(deps: BrowserToolDeps): Tool {
  return {
    spec: {
      name: 'browser_upload',
      description:
        "Upload a file from this computer into the page. Give the file's path and the upload button or file field by its [number] from the outline.",
      schema: schema(['index', 'path'], {
        index: int('Element number of the upload button or file field'),
        path: str('Full path of the file on this computer'),
      }),
    },
    run: async (input, ctx) => {
      const index = requiredIndex(input['index'])
      if (index === null) return 'Pass the number of the upload button or file field.'
      const path = text(input['path']).trim()
      if (path === '') return 'Pass the full path of the file to upload.'
      if (path.length > MAX_PATH) return 'That path is too long.'
      // Uploading the file it was asked to is ordinary work (main/ask-rule.ts); a key, password store or secrets
      // file leaving this computer still asks.
      if (secretFile(path)) {
        const approved = await ctx.approve(`Upload ${fileLabel(path)} to the page?`, path)
        if (!approved) return 'The user declined the upload.'
      }
      return call(() => deps.browser.upload(index, path))
    },
  }
}

function handoffTool(deps: BrowserToolDeps): Tool {
  return {
    spec: {
      name: 'browser_handoff',
      description:
        'When a page needs a human (a sign-in, captcha, two-factor code or consent), hand the browser to the person and wait until they say they are done. The page opens full size for them; only that tab is theirs until they hand it back (other agents keep working in their own tabs). Use browser_wait_for or browser_read afterwards to check.',
      schema: schema(['reason'], {
        reason: str('What they need to do, in one line'),
      }),
    },
    run: async (input, ctx) => {
      const reason = text(input['reason']).trim()
      if (reason === '') return 'Say what the person needs to do in reason.'
      const name = deps.agentName?.().trim() || 'Your agent'
      deps.browser.setAgentDriving(false, reason)
      await ctx.notify('Your agent needs a hand', reason)
      try {
        const answer = await ctx.ask(`${name} needs you in the browser: ${reason}`, [
          HANDOFF_DONE,
          HANDOFF_SKIP,
          NO,
        ])
        if (answer === null) return 'No one is around to help right now.'
        if (answer === NO) return TURNED_DOWN
        if (answer === HANDOFF_SKIP) return 'The user skipped it.'
        if (answer === HANDOFF_CLOSED) return 'The user closed that tab without saying they were done. Do not reopen it on your own; tell them what you still need, in one line.'
        return 'The user says they are done. Read the page to check.'
      } finally {
        deps.browser.setAgentDriving(true)
      }
    },
  }
}

function showUserTool(deps: BrowserToolDeps): Tool {
  return {
    spec: {
      name: 'browser_show_user',
      description:
        'Show the user a screenshot of the page in the chat, for receipts, results or things they should see.',
      schema: schema([], {
        caption: str('One line saying what it shows'),
      }),
    },
    run: async (input) => {
      const path = await deps.browser.screenshot()
      if (path === null) return 'Screenshot failed. Is a page open?'
      const caption = text(input['caption']).trim()
      const first = caption === '' ? 'Screenshot' : caption
      return `${first}\nShown to the user. You can see it too:\n[[image:${path}]]`
    },
  }
}

async function call(action: () => Promise<string>): Promise<string> {
  try {
    return await action()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `The browser had a problem: ${message}`
  }
}

function requiredIndex(value: unknown): number | null {
  const parsed = optionalIndex(value)
  return parsed === 'bad' || parsed === null ? null : parsed
}

/** A number, a numeric string, or null when the field was left out. 'bad' means it was nonsense. */
function optionalIndex(value: unknown): number | null | 'bad' {
  if (value === undefined || value === null || value === '') return null
  let parsed: number
  if (typeof value === 'number') parsed = value
  else if (typeof value === 'string' && /^\d+$/.test(value.trim())) parsed = Number(value.trim())
  else return 'bad'
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100_000) return 'bad'
  return parsed
}

function secondsArg(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return 15
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function fileLabel(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? 'that file'
}
