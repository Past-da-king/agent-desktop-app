/**
 * Guided click-through tools (26 Oct 2026). For the rare step a site will only take from a real person, the agent
 * highlights the ONE thing to use next and his own click is the feedback (browser/guide.ts). Every request his clicks
 * make the page send is kept per step (browser/guide-log.ts), so a watcher can read it while he clicks, and the
 * session can become a learned app that does the task by API next time (browser/guide-app.ts).
 *
 * API first, UI last: the guide is the fallback, for when the site's API is blocked or flagged as a bot.
 */
import { int, schema, str, type JsonObject, type Tool } from '@agent/core'

import { appFromSession } from '../browser/guide-app'
import { formatLog, type GuideLog } from '../browser/guide-log'
import type { GuideStep, GuideTarget } from '../browser/guide'
import type { GuideRequest } from '../browser/types'
import { checkBrowserUrl } from '../browser/url-policy'
import { syntaxError } from '../apps/page-js'
import { hostOf, slugOf, type LearnedStore, type LearnedTool } from '../apps/store'
import { problem } from './webapps'

interface GuideDriver {
  guide(request: GuideRequest, signal?: AbortSignal): Promise<string>
  guideLog(): GuideLog
}

export interface BrowserGuideToolDeps {
  browser: unknown
  learned?: LearnedStore
}

export const MAX_GUIDE_STEPS = 20

function guideDriver(value: unknown): GuideDriver | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<GuideDriver>
  return typeof candidate.guide === 'function' && typeof candidate.guideLog === 'function' ? (candidate as GuideDriver) : null
}

const NO_GUIDE = 'Guiding needs a browser a person is looking at, and this device has none. Run it on the computer he is at.'

export function browserGuideTools(deps: BrowserGuideToolDeps): Tool[] {
  const tools = [guideTool(deps), logTool(deps)]
  if (deps.learned !== undefined) tools.push(saveTool(deps, deps.learned))
  return tools
}

const STEP_FIELDS: Record<string, JsonObject> = {
  label: str('What he should do, a few words: "Click Create Pixel", "Type the pixel name"'),
  name: str('The element name as browser_snapshot shows it (best: found again live)'),
  role: str('button, link, textbox, checkbox, combobox, tab, menuitem...'),
  nth: int('Which one when several share the name, 1 is the first'),
  index: int('Element number from browser_snapshot'),
  selector: str('A CSS selector, when there is no good name'),
  value: str('Clipboard fill for a field: the value to put on his clipboard so he only pastes it. A {{vault:REF}} placeholder works and is never shown'),
  sensitive: { type: 'boolean', description: 'The value is secret: the label names only the field, the value is never shown or kept, and the clipboard is cleared after his paste' },
}

function guideTool(deps: BrowserGuideToolDeps): Tool {
  return {
    spec: {
      name: 'browser_guide',
      description:
        "Show the person where to click, in your browser: ONE element at a time gets a ring and a short label, he does it himself (his click or typing is the feedback), and the next step lights up at once. Nothing is clicked for him. Returns the moment he acts, or when a target is missing (the page surprised you: re-plan), he presses I did it / Skip, or it times out. API FIRST: before guiding, find the site's API (browser_network while the page works, browser_fetch to replay it, or a learned app) and use that; guide only when the API is blocked or refused as a bot, a step needs his own hands (sign-in, consent, a site that blocks automation), or he asks you to show him. Chain the steps you already know in steps. A field whose value you know gets value: it goes on his clipboard and the label says so, so he only clicks and pastes (a {{vault:REF}} or sensitive value is never shown and the clipboard is cleared after his paste). Every request his clicks send is kept per step: browser_guide_log reads it (a watcher helper can, while he clicks) and browser_guide_save_app turns the session into a learned app so next time runs by API.",
      schema: schema([], {
        ...STEP_FIELDS,
        steps: {
          type: 'array',
          description: 'Several steps in order, each {label, name, role, nth} or {label, selector} or {label, index}. Each is highlighted the moment the one before is done.',
          items: { type: 'object', properties: STEP_FIELDS, required: ['label'] },
        },
        timeout_seconds: int('How long he has for the whole guide, default 300 (10 to 1800)'),
      }),
    },
    run: async (input, ctx) => {
      const driver = guideDriver(deps.browser)
      if (driver === null) return NO_GUIDE
      const raw = Array.isArray(input['steps']) && input['steps'].length > 0 ? input['steps'] : [input]
      if (raw.length > MAX_GUIDE_STEPS) return `At most ${MAX_GUIDE_STEPS} steps in one guide.`
      const steps: GuideStep[] = []
      for (const [i, item] of raw.entries()) {
        const step = stepOf(item)
        if (typeof step === 'string') return `Step ${i + 1}: ${step}`
        steps.push(step)
      }
      const seconds = typeof input['timeout_seconds'] === 'number' && Number.isFinite(input['timeout_seconds']) ? Math.min(1800, Math.max(10, Math.floor(input['timeout_seconds']))) : 300
      try {
        return await driver.guide({ steps, timeoutMs: seconds * 1000 }, ctx.signal)
      } catch (error) {
        return `The browser had a problem: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }
}

/** One step from the model's input, or why it cannot be used. */
export function stepOf(raw: unknown): GuideStep | string {
  const o = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const text = (key: string): string => (typeof o[key] === 'string' ? (o[key] as string).trim() : '')
  const num = (key: string): number | undefined => {
    const v = o[key]
    if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v)
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim())
    return undefined
  }
  const target: GuideTarget = {}
  const name = text('name')
  const role = text('role')
  const selector = text('selector')
  const index = num('index')
  const nth = num('nth')
  if (name !== '') target.name = name
  if (role !== '') target.role = role
  if (selector !== '') target.selector = selector
  if (index !== undefined) target.index = index
  if (nth !== undefined && nth > 0) target.nth = nth
  if (target.name === undefined && target.selector === undefined && target.index === undefined) return 'say which element: name (and role), selector, or index.'
  const label = text('label') || (name !== '' ? `Use ${name}` : 'Use this')
  const value = typeof o['value'] === 'string' ? (o['value'] as string) : typeof o['value'] === 'number' ? String(o['value']) : ''
  if (value.length > 4_000) return 'that value is too long for a field.'
  return { target, label: label.slice(0, 80), ...(value === '' ? {} : { value }), ...(value !== '' && o['sensitive'] === true ? { sensitive: true } : {}) }
}

function logTool(deps: BrowserGuideToolDeps): Tool {
  return {
    spec: {
      name: 'browser_guide_log',
      description:
        "Read a guided session's step log: which step he is on, what each step was, and every API request (method, address, status, headers with secrets masked, body, start of the reply) his action on that step made the page send. A watcher helper can sit beside a running guide: call with after_step = the last step you saw and wait_seconds, and it answers the moment the next step is done. session 'latest' (default) is the newest guide, waiting for one to start if there is none yet.",
      schema: schema([], {
        session: str("The session id browser_guide gave, or 'latest'"),
        after_step: int('Only steps after this one; 0 for all'),
        wait_seconds: int('Wait up to this long for a newer step (0 to 120, default 0)'),
      }),
    },
    run: async (input, ctx) => {
      const driver = guideDriver(deps.browser)
      if (driver === null) return NO_GUIDE
      const log = driver.guideLog()
      const id = typeof input['session'] === 'string' && input['session'].trim() !== '' ? input['session'].trim() : 'latest'
      const after = typeof input['after_step'] === 'number' ? Math.max(0, Math.floor(input['after_step'])) : 0
      const wait = typeof input['wait_seconds'] === 'number' ? Math.min(120, Math.max(0, Math.floor(input['wait_seconds']))) : 0
      await log.waitFor(id, after, wait * 1000, ctx.signal)
      const session = log.get(id)
      if (session === null) return id === 'latest' ? 'No guided session yet.' : `No guided session ${id}.`
      return formatLog(session, log.requests(session.id), after)
    },
  }
}

function saveTool(deps: BrowserGuideToolDeps, store: LearnedStore): Tool {
  return {
    spec: {
      name: 'browser_guide_save_app',
      description:
        'Turn a finished guided session into a learned app, so next time the task runs by API in one call with no clicks (webapp_run). It replays the requests his clicks sent; what he typed becomes the tool\'s inputs. Authorization, cookies, CSRF and every token are NOT saved: the tool reads them fresh from the signed-in page each run. If the site refuses the replay as a bot, the tool says so and gives the guided steps to fall back to.',
      schema: schema(['app_name', 'tool_name', 'description'], {
        session: str("The session id browser_guide gave, or 'latest'"),
        app_name: str("The app's name, e.g. the site's name"),
        tool_name: str('Tool name: lower-case letters, digits, underscores, e.g. create_pixel'),
        description: str('What the tool does and when to use it, one line'),
      }),
    },
    run: async (input) => {
      const driver = guideDriver(deps.browser)
      if (driver === null) return NO_GUIDE
      const log = driver.guideLog()
      const id = typeof input['session'] === 'string' && input['session'].trim() !== '' ? input['session'].trim() : 'latest'
      const session = log.get(id)
      if (session === null) return `No guided session ${id}.`
      if (session.endedAt === null) return 'That guide is still running. Save it once it has ended.'
      const name = typeof input['app_name'] === 'string' ? input['app_name'].trim() : ''
      const toolName = typeof input['tool_name'] === 'string' ? input['tool_name'].trim() : ''
      const description = typeof input['description'] === 'string' ? input['description'].trim() : ''
      if (name.length < 2 || name.length > 40) return 'Not saved: give the app a name of 2 to 40 characters.'
      const appId = slugOf(name)
      if (appId === '') return 'Not saved: that name has nothing usable in it.'
      const draft = appFromSession(session, log.requests(session.id), { toolName, description })
      if (draft.problem !== null) return `Not saved: ${draft.problem}`
      if (!draft.startUrl.startsWith('https://') || hostOf(draft.startUrl) === '' || !checkBrowserUrl(draft.startUrl).ok) return 'Not saved: a learned app lives on a public https site, and this session was not on one.'
      const tool: LearnedTool = { ...draft.tool, params: draft.tool.params as unknown as JsonObject }
      const why = problem(tool)
      if (why !== null) return `Not saved: ${why}`
      const err = syntaxError(tool.js)
      if (err !== '') return `Not saved: the generated code does not parse (${err}).`
      const existing = store.find(appId)
      const tools = [...(existing?.tools ?? []).filter((t) => t.name !== tool.name), tool]
      const steps = draft.fallback.map((step) => step.label).join(' > ')
      const about = [existing?.about ?? '', `${tool.name}: learned from a guided session (${steps}). Secrets are read fresh at run time.`].filter((line) => line !== '').join('\n').slice(0, 1500)
      store.save({ ...(existing ?? { trusted: false }), id: appId, name: existing?.name ?? name, startUrl: existing?.startUrl ?? draft.startUrl, about, tools, trusted: existing?.trusted ?? false, updatedAt: 0 })
      const inputs = Object.keys(draft.tool.params)
      return [
        `Saved ${tool.name} in ${existing?.name ?? name} (${draft.requests} request${draft.requests === 1 ? '' : 's'} replayed by API, ${draft.tool.readOnly ? 'reads only' : 'changes things'}).`,
        inputs.length === 0 ? 'Inputs: none.' : `Inputs: ${inputs.join(', ')}.`,
        draft.fresh.length === 0 ? 'Nothing secret to read.' : `Read fresh from the signed-in page each run, never saved: ${draft.fresh.join(', ')}.`,
        `Run it with webapp_run app="${existing?.name ?? name}" tool="${tool.name}". If the site refuses it as a bot, it answers with the guided steps to use instead.`,
      ].join('\n')
    },
  }
}
