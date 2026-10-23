/**
 * Learned apps: the agent maps a website once in its own browser and saves small tools for it, run as
 * JavaScript inside the signed-in page. Ported from reference phone connections/WebAppTools.kt.
 *
 * One deviation: the phone turns each saved tool into its own web_<app>_<tool> tool. Here the toolset
 * is built once at start and shared by the runner, the helpers and the CLI host, so saved tools run
 * through webapp_run (app, tool, args) instead; webapp_list names them all.
 *
 * Asking (main/ask-rule.ts, 23 Oct 2026): ordinary changes (send, post, reply, edit) run without a card.
 * A tool asks the person first only when it deletes or cannot be undone, costs money, or touches going live / DNS
 * or secrets (its name or description says so, or it was saved with asks_first), or when the person switched
 * "Ask before each change" on for that app in Connections. A trusted app never asks.
 */
import { clipResult, enumOf, int, resultLimitOf, schema, str, type JsonObject, type JsonValue, type Tool, type ToolContext } from '@agent/core'

import { FILE_KEY, FILE_TYPE, prepareFileArgs, runTimeoutFor, sendFilesToPage, sizeText, type FileArg } from '../apps/page-files'
import { netClear, netLog, netStart, netStop, runScript, runScriptWithFiles, syntaxError } from '../apps/page-js'
import { MAX_APPS, MAX_JS, MAX_TOOLS, hostOf, slugOf, type LearnedApp, type LearnedStore, type LearnedTool } from '../apps/store'
import type { BrowserDriver } from '../browser/types'
import { checkBrowserUrl } from '../browser/url-policy'
import { needsYes } from '../ask-rule'

export const GUIDE = `TEACHING YOURSELF A WEB APP (a site with no API, anything you would otherwise click through every time)

The idea: map the app once, then write tools so next time you call a tool instead of clicking. Tools run as JavaScript inside the page of your own browser, so the person's sign-in there is used and no password is stored.

1. OPEN IT. browser_open the site. If it needs a sign-in, a QR code or a code, use browser_handoff and let the person do it; the session stays signed in for next time.
2. WATCH WHAT IT SENDS. Your tab records every request, like DevTools. browser_network clear=true, do the real action in the page (search, open an item, load the next page), then browser_network api=true (url= a word in the address). browser_network_get with an id shows the whole request and reply, and browser_fetch tries a call again with your own changes. Look for JSON endpoints: those are the best thing to build on.
3. LOOK INSIDE. browser_eval runs JavaScript in the page and returns what you return: read the DOM (document.querySelector...), find stable selectors and aria-labels, call the site's own endpoints with fetch(url, {credentials:'include'}). Prefer in this order: (a) the site's internal JSON endpoints with fetch, (b) data the page already holds, (c) reading and driving the DOM. Avoid coordinates and visible-text guesses that break when the page changes. Never print tokens or cookie values.
4. WRITE SMALL TOOLS. One tool per thing: search_items, get_item, list_messages... Each tool is the BODY of an async function that sees \`args\` and returns something JSON-able (trim lists to what matters). Throw an Error with a plain message when it cannot work (not signed in, element missing). Mark read_only=true only if it changes nothing; sending, posting, deleting, buying are read_only=false. Ordinary changes (send, post, reply, edit) run without asking; set asks_first=true on a tool that deletes, cannot be undone, costs money, deploys, touches DNS, or handles secrets, so the person is asked before each run.
5. TEST BEFORE SAVING. Run the body with browser_eval first (set const args = {...} at the top for the test), then save with webapp_save, then run each tool once with webapp_test. If a tool fails, fix it and save again (same name replaces).
6. IT SAVES FOR NEXT TIME. webapp_save saves the tool set straight away (no card). After that you and your helpers call them with webapp_run. If the site changes and a tool breaks, remap that tool and save again.

FILES (upload, send a photo, video or document): declare the input with type "file". Whoever runs the tool passes the file's full path on this computer (or {"${'$'}file": "C:/path/clip.mp4"} for any input), and the app itself reads the file and moves it into the page in chunks: in the body that input is a real File (a Blob with .name, .type and .size), however big (up to 1 GB). Use it as the site would: new FormData().append('file', args.video), await args.video.arrayBuffer(), or hand it to the site's own upload code. Never make a tool take file bytes as base64: that sends the whole file through the model.

WHO MAY RUN THEM: a learned app follows the browser sign-in. You, General helpers and routines browse in the same browser, so they can all run what is signed in there; a helper in another profile runs the apps in its profile's list plus any whose site is signed in in its profile's browser. Sign-ins live on one device: an agent working on another device (a helper on a linked server) still runs webapp_run here, and the app runs the tool in the browser of the device where the app is signed in by itself (device: names one). A file path then means a file on the device that runs the tool.

BACKSLASHES: your tool call is JSON, and backslashes inside code are the main reason a save fails. Write code that needs none: [0-9] not \\d, [.] not \\., [/] not \\/, single quotes inside selectors, and new RegExp(...) built from those.

Rules: never put a password, token or cookie value in a tool or in your reply. Reading, sending and posting are fine; deleting, paying, deploying, DNS and secrets go through approval. If a site's terms forbid automation, or it needs a CAPTCHA every time, say so instead of working around it.`

export const EXAMPLE =
  "e.g. Hacker News: const r = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json'); const ids = (await r.json()).slice(0, args.limit || 10); return ids;"

/** What the learned-app tools need from a browser. Tests hand in a fake. */
export interface PageRunner {
  /** Get the browser onto the app's site. Signing in is the person's job. */
  ensure(app: LearnedApp): Promise<void>
  /**
   * Runs a tool body that sees `args`; resolves {ok, v} or {ok:false, e}. With `files` (apps/page-files.ts)
   * the files are sent into the page first and the body sees each as a File.
   */
  run(body: string, args: JsonObject, files?: FileArg[]): Promise<{ ok: boolean; v?: unknown; e?: string }>
  /** Runs raw script text in the page (browser_eval, browser_network). */
  evaluate(code: string, timeoutMs?: number): Promise<unknown>
}

export function browserRunner(browser: BrowserDriver): PageRunner {
  const evaluate = async (code: string, timeoutMs?: number): Promise<unknown> => {
    if (browser.evaluateRaw === undefined) throw new Error('The browser is not open right now.')
    return timeoutMs === undefined ? browser.evaluateRaw(code) : browser.evaluateRaw(code, timeoutMs)
  }
  return {
    async ensure(app) {
      // One tab per site: a one-session site (WhatsApp Web) drops a second tab with "Use here".
      if (browser.useSiteTab?.(app.startUrl) === true) return
      const host = hostOf(app.startUrl).toLowerCase()
      const now = hostOf(browser.currentUrl?.() ?? '').toLowerCase()
      const onSite = host !== '' && (now === host || now.endsWith(`.${host}`))
      if (!onSite) await browser.open(app.startUrl)
    },
    async run(body, args, files = []) {
      try {
        if (files.length > 0) await sendFilesToPage(files, evaluate)
        const out = await (files.length === 0
          ? evaluate(runScript(body, args))
          : evaluate(runScriptWithFiles(body, args, files.map((f) => f.key)), runTimeoutFor(files)))
        const o = out !== null && typeof out === 'object' ? (out as Record<string, unknown>) : {}
        if (o['ok'] === true) return { ok: true, v: o['v'] }
        return { ok: false, e: typeof o['e'] === 'string' ? o['e'] : 'failed' }
      } catch (cause) {
        return { ok: false, e: cause instanceof Error ? cause.message : String(cause) }
      }
    },
    evaluate,
  }
}

const TOOL_NAME = /^[a-z][a-z0-9_]{1,29}$/
const PARAM_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,29}$/
const PARAM_TYPES = new Set(['string', 'number', 'integer', 'boolean', FILE_TYPE])

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}

/** Result text for the model: the value as JSON, trimmed (as a valid object, never cut JSON); or the error. */
export function resultText(res: { ok: boolean; v?: unknown; e?: string }, max = 20_000): string {
  if (!res.ok) return `Error: ${res.e !== undefined && res.e !== '' ? res.e : 'failed'}`
  const v = res.v === undefined || res.v === null ? 'null' : typeof res.v === 'string' ? res.v : JSON.stringify(res.v)
  return clipResult(v, max)
}

/** Why a tool definition cannot be saved, or null. */
export function problem(t: LearnedTool): string | null {
  if (!TOOL_NAME.test(t.name)) {
    return `Tool name "${t.name}" must be lower-case letters, digits and underscores, 2 to 30 characters, starting with a letter.`
  }
  if (t.description.trim() === '') return `${t.name}: add a description saying what it does and when to use it.`
  if (t.js.trim() === '') return `${t.name}: the js body is empty (0 characters arrived). If you did write it, the call may have been cut off: send fewer tools per call.`
  if (t.js.length > MAX_JS) return `${t.name}: the js is too long (${t.js.length} characters, limit ${MAX_JS}). Split it into smaller tools.`
  for (const [key, value] of Object.entries(t.params)) {
    if (!PARAM_NAME.test(key) || !PARAM_TYPES.has(text(asObject(value)['type']))) {
      return `${t.name}: each input needs a plain name and a type of string, number, integer, boolean or file.`
    }
  }
  if (t.required.some((r) => !(r in t.params))) return `${t.name}: required lists an input that is not defined.`
  return null
}

export function toolFromInput(raw: unknown): LearnedTool {
  const o = asObject(raw)
  const p = asObject(o['params'])
  const params: JsonObject = {}
  for (const [key, value] of Object.entries(p)) {
    params[key] = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { type: 'string' }
  }
  const required = Array.isArray(o['required']) ? o['required'].filter((r): r is string => typeof r === 'string') : []
  const readOnly = o['read_only'] === undefined ? o['readOnly'] !== false : o['read_only'] !== false
  return {
    name: text(o['name']).trim(),
    description: text(o['description']).trim(),
    params,
    required,
    js: text(o['js']),
    readOnly,
    ...(o['asks_first'] === true || o['asksFirst'] === true ? { asksFirst: true } : {}),
  }
}

/**
 * Whether running this tool asks the person first (main/ask-rule.ts): never for a trusted app or a reading tool;
 * always when the person asked to be asked for this app; else only for a tool that deletes, cannot be undone,
 * costs money, deploys, touches DNS or secrets.
 */
export function learnedAsks(app: LearnedApp, tool: LearnedTool): boolean {
  if (app.trusted || tool.readOnly) return false
  if (app.askFirst === true) return true
  return tool.asksFirst === true || needsYes(`${tool.name} ${tool.description}`)
}

/** Runs one saved tool. Only what deletes, costs money, goes live or touches secrets asks first (learnedAsks). */
export async function callLearned(app: LearnedApp, tool: LearnedTool, input: JsonObject, ctx: ToolContext, runner: PageRunner): Promise<string> {
  const missing = tool.required.filter((r) => input[r] === undefined || input[r] === null)
  if (missing.length > 0) return `Missing input: ${missing.join(', ')}.`
  // Files on this computer named in the inputs: checked now, sent into the page by the app itself (page-files.ts).
  const prepared = await prepareFileArgs(tool.params, input)
  if (!prepared.ok) return `Error: ${prepared.error}`
  const files = prepared.files
  if (learnedAsks(app, tool)) {
    const keys = Object.keys(input)
    const what = keys.length === 0 ? 'No inputs.' : keys.map((k) => `${k}: ${JSON.stringify(input[k]).slice(0, 600)}`).join('\n')
    const sent = files.length === 0 ? '' : `\nFiles from this computer it hands to the site: ${files.map((f) => `${f.name} (${sizeText(f.size)})`).join(', ')}`
    const yes = await ctx.approve(`${app.name}: ${tool.description.slice(0, 90)}`, `${what}${sent}`)
    if (!yes) return 'DECLINED, or nobody was around to approve. Do not do it.'
  }
  const label = `${app.name}: ${tool.name.replace(/_/g, ' ')}`
  const id = await ctx.activity(label, { tool: 'browser' })
  let out: string
  try {
    await runner.ensure(app)
    out = resultText(await (files.length === 0 ? runner.run(tool.js, input) : runner.run(tool.js, prepared.args, files)), resultLimitOf(ctx, 20_000))
  } catch (cause) {
    out = `Error: could not run ${tool.name} (${cause instanceof Error ? cause.message : String(cause)}).`
  }
  await ctx.updateActivity(id, out.startsWith('Error:') ? `${label} (failed)` : label, { tool: 'browser' })
  return out
}

export function webAppTools(store: LearnedStore | undefined, runner: PageRunner | undefined): Tool[] {
  if (store === undefined || runner === undefined) return []
  return [
    guideTool(),
    listTool(store),
    saveTool(store),
    runTool(store, runner, 'webapp_run'),
    runTool(store, runner, 'webapp_test'),
    removeTool(store),
    evalTool(runner),
    networkTool(runner),
  ]
}

function guideTool(): Tool {
  return {
    spec: {
      name: 'webapp_guide',
      description:
        "How to teach yourself a web app (any site you would otherwise click through every time): map it once, write your own tools, and use them from then on. Read this before you start.",
      schema: schema([], {}),
    },
    run: async () => `${GUIDE}\n\n${EXAMPLE}`,
  }
}

function listTool(store: LearnedStore): Tool {
  return {
    spec: {
      name: 'webapp_list',
      description: 'The web apps you have taught yourself, and the tools each has. Run them with webapp_run.',
      schema: schema([], {}),
    },
    run: async () => {
      const apps = store.apps()
      if (apps.length === 0) return 'None yet. Read webapp_guide to teach yourself one.'
      return apps
        .map((a) => {
          const head = `${a.name} (${a.startUrl}${a.trusted ? ', the person trusts its changes' : a.askFirst === true ? ', the person asks to approve every change' : ''})`
          const about = a.about !== '' ? `\n${a.about}` : ''
          const tools = a.tools
            .map((t) => `- ${t.name} [${t.readOnly ? 'reads' : learnedAsks(a, t) ? 'CHANGES things, asks first' : 'CHANGES things'}]: ${t.description}${Object.keys(t.params).length > 0 ? ` Inputs: ${JSON.stringify(t.params)}` : ''}`)
            .join('\n')
          return `${head}${about}\n${tools}`
        })
        .join('\n\n')
    },
  }
}

function saveTool(store: LearnedStore): Tool {
  const toolSchema: JsonObject = {
    type: 'object',
    properties: {
      name: str('Tool name: lower-case letters, digits, underscores, 2 to 30 characters, e.g. search_items'),
      description: str('What it does and when to use it, one or two lines'),
      params: {
        type: 'object',
        description:
          'Inputs: {inputName: {type: string|number|integer|boolean|file, description: ...}}. type file: the caller passes a full path on this computer and the body gets a File (name, type, bytes), however big; never take file bytes as base64.',
      },
      required: { type: 'array', items: { type: 'string' } },
      js: str('The BODY of an async function. It sees `args` and returns something JSON-able. No function wrapper.'),
      read_only: { type: 'boolean', description: 'true only if it changes nothing. Sending, posting, deleting, buying: false.' },
      asks_first: {
        type: 'boolean',
        description: 'true for a tool that deletes, cannot be undone, costs money, deploys, touches DNS or handles secrets: the person is asked before each run. Ordinary sending, posting and editing: leave it out.',
      },
    },
    required: ['name', 'description', 'js', 'read_only'],
  }
  return {
    spec: {
      name: 'webapp_save',
      description:
        'Save the tools you wrote for a web app, so next time you call them instead of clicking through it. Read webapp_guide first, and test each body with browser_eval. It saves straight away. Saving an app that exists replaces its tools.',
      schema: schema(['name', 'start_url', 'tools'], {
        name: str("The app's name, e.g. Hacker News"),
        start_url: str('Where it lives: https://news.ycombinator.com'),
        about: str('One or two lines: what it is and anything to know (how sign-in works, quirks). Never a password, key or cookie.'),
        tools: { type: 'array', items: toolSchema },
      }),
    },
    run: async (input) => {
      const name = text(input['name']).trim()
      const rawUrl = text(input['start_url']).trim()
      const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`
      if (name.length < 2 || name.length > 40) return 'Not saved: give the app a name of 2 to 40 characters.'
      const id = slugOf(name)
      if (id === '') return 'Not saved: that name has nothing usable in it.'
      if (!url.startsWith('https://') || hostOf(url) === '' || !checkBrowserUrl(url).ok) return 'Not saved: start_url must be a public https address.'
      const raw = Array.isArray(input['tools']) ? (input['tools'] as JsonValue[]) : []
      const tools = raw.map(toolFromInput)
      if (tools.length === 0) return 'Not saved: tools is empty.'
      if (tools.length > MAX_TOOLS) return `Not saved: at most ${MAX_TOOLS} tools per app.`
      const seen = new Set<string>()
      for (const t of tools) {
        if (seen.has(t.name)) return `Not saved: the tool name ${t.name} is used twice.`
        seen.add(t.name)
      }
      for (const t of tools) {
        const why = problem(t)
        if (why !== null) return `Not saved: ${why}`
      }
      const replacing = store.find(id) !== null
      if (!replacing && store.apps().length >= MAX_APPS) return `Not saved: too many apps (${MAX_APPS}). Remove one first.`
      for (const t of tools) {
        const err = syntaxError(t.js)
        if (err !== '') {
          return `Not saved: the js of ${t.name} does not parse: ${err}. It arrived as ${t.js.length} characters, starting "${t.js.slice(0, 50).replace(/\n/g, ' ')}" and ending "${t.js.slice(-50).replace(/\n/g, ' ')}". If it ends mid-statement the reply was cut off: send fewer or shorter tools per call. If it has a regex or selector with backslashes, rewrite it without them.`
        }
      }
      // Saving tools is ordinary work: no card (main/ask-rule.ts). Running a risky one still asks.
      store.save({ id, name, startUrl: url, about: text(input['about']).trim(), tools, trusted: false, updatedAt: 0 })
      return `Saved ${name} with ${tools.length} tool${tools.length === 1 ? '' : 's'}: ${tools.map((t) => t.name).join(', ')}. Try each with webapp_test now; from here on you and your helpers run them with webapp_run.`
    },
  }
}

function runTool(store: LearnedStore, runner: PageRunner, name: 'webapp_run' | 'webapp_test'): Tool {
  return {
    spec: {
      name,
      description:
        name === 'webapp_run'
          ? `Run one tool of a web app you taught yourself (see webapp_list). Reading and ordinary changes (send, post, reply, edit) run straight away; a tool that deletes, cannot be undone, costs money, deploys, touches DNS or secrets asks the person first (and every change does for an app the person set to ask first). A file on this computer goes in as its full path (an input of type file) or as {"${FILE_KEY}": "C:/path/video.mp4"}: the app moves the bytes into the page itself, any size up to 1 GB, never base64 through you.`
          : 'Run one tool of a saved web app now, to check it works. Same rules as webapp_run: only deleting, paying, deploying, DNS or secrets ask the person first; files go in as a path.',
      schema: schema(['app', 'tool'], {
        app: str("The app's name"),
        tool: str("The tool's name, e.g. search_items"),
        args: { type: 'object', description: `Inputs, e.g. {"query":"rust"}. A file: its full path for an input of type file, or {"${FILE_KEY}": "C:/path/file.pdf"} for any input.` },
      }),
    },
    run: async (input, ctx) => {
      const app = store.find(text(input['app']))
      if (app === null) return `No saved app called ${text(input['app'])}. webapp_list shows them.`
      const tool = app.tools.find((t) => t.name === text(input['tool']).trim())
      if (tool === undefined) return `${app.name} has no tool ${text(input['tool'])}: ${app.tools.map((t) => t.name).join(', ')}.`
      let args = input['args']
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args === '' ? '{}' : args) as JsonValue
        } catch {
          return 'args must be a JSON object.'
        }
      }
      return callLearned(app, tool, asObject(args), ctx, runner)
    },
  }
}

function removeTool(store: LearnedStore): Tool {
  return {
    spec: {
      name: 'webapp_remove',
      description: 'Remove a saved web app and its tools (the person is asked first).',
      schema: schema(['app'], { app: str("The app's name") }),
    },
    run: async (input, ctx) => {
      const app = store.find(text(input['app']))
      if (app === null) return `No saved app called ${text(input['app'])}.`
      const yes = await ctx.approve(`Remove the ${app.name} tools`, `${app.tools.length} tools will be deleted. You can teach them again later.`)
      if (!yes) return 'DECLINED. Keep it.'
      store.remove(app.id)
      return `Removed ${app.name}.`
    },
  }
}

function evalTool(runner: PageRunner): Tool {
  return {
    spec: {
      name: 'browser_eval',
      description:
        "Run JavaScript in the current page of your browser and get back what it returns (the body of an async function; use return). For mapping a site before writing tools: read the DOM, find selectors, call the site's own JSON endpoints with fetch(url, {credentials:'include'}). Never return tokens or cookie values.",
      schema: schema(['js'], { js: str('The body of an async function, e.g. return document.title') }),
    },
    run: async (input) => {
      const js = text(input['js'])
      if (js.trim() === '') return 'Pass the JavaScript to run.'
      if (js.length > MAX_JS) return `That is too long (${js.length} characters, limit ${MAX_JS}).`
      const err = syntaxError(js)
      if (err !== '') return `Error: it does not parse: ${err}`
      try {
        return resultText(await runner.run(js, {}), 12_000)
      } catch (cause) {
        return `Error: ${cause instanceof Error ? cause.message : String(cause)}`
      }
    },
  }
}

function networkTool(runner: PageRunner): Tool {
  return {
    spec: {
      name: 'browser_network',
      description:
        "Watch what the current page sends, to find a site's JSON endpoints: start, then do the action in the page, then log (optionally filtered by a word in the URL). A new page load stops the watcher; start it again.",
      schema: schema(['action'], {
        action: enumOf('What to do', 'start', 'log', 'stop', 'clear'),
        filter: str('For log: only calls whose method or URL contain this'),
        limit: int('For log: how many of the newest calls, default 30'),
      }),
    },
    run: async (input) => {
      const action = text(input['action'])
      try {
        if (action === 'start') {
          await runner.evaluate(netStart())
          return 'Watching. Do the action in the page now, then browser_network log.'
        }
        if (action === 'stop') {
          await runner.evaluate(netStop())
          return 'Stopped watching.'
        }
        if (action === 'clear') {
          await runner.evaluate(netClear())
          return 'Cleared.'
        }
        if (action === 'log') {
          const raw = input['limit']
          const out = asObject(await runner.evaluate(netLog(text(input['filter']), typeof raw === 'number' ? raw : 30)))
          if (out['hooked'] !== true) return 'Not watching this page. The page may have reloaded: browser_network start, then do the action again.'
          const calls = Array.isArray(out['calls']) ? out['calls'] : []
          if (calls.length === 0) return 'No calls recorded yet. Do the action in the page, then log again.'
          return JSON.stringify(calls, null, 1).slice(0, 16_000)
        }
        return 'action must be start, log, stop or clear.'
      } catch (cause) {
        return `Error: ${cause instanceof Error ? cause.message : String(cause)}`
      }
    },
  }
}
