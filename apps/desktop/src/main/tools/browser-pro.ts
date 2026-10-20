/**
 * The stronger browser tools, after the A.O.S browser that agents drive well even on hard sites:
 * the agent changes how the browser presents itself when a site is broken (browser_view), fixes the
 * site on the fly and has the fix remembered (browser_fix), reads the page as numbered elements with
 * role, name and state (browser_snapshot), acts by name with trusted input (browser_act), and runs a
 * whole multi-step script inside the page with a returned log (browser_eval).
 */
import { bool, enumOf, int, schema, str, type JsonObject, type Tool } from '@agent/core'

import { viewModeOf } from '../browser/emulation'
import {
  isBrowserPro,
  unavailableBrowserPro,
  type ActAction,
  type BrowserProDriver,
  type FixAction,
  type ViewRequest,
} from '../browser/types'

export interface BrowserProToolDeps {
  browser: unknown
}

const MAX_SCRIPT = 60_000
const ACTIONS: ActAction[] = [
  'click',
  'double_click',
  'right_click',
  'type',
  'select',
  'check',
  'uncheck',
  'hover',
  'focus',
  'press',
  'hold',
  'drag',
  'scroll',
]
const FIXES: FixAction[] = ['css', 'js', 'clear_data', 'headers', 'user_agent', 'retry', 'forget', 'list']

export function browserProTools(deps: BrowserProToolDeps): Tool[] {
  const browser: BrowserProDriver = isBrowserPro(deps.browser) ? deps.browser : unavailableBrowserPro
  return [viewTool(browser), fixTool(browser), snapshotTool(browser), actTool(browser), evalTool(browser)]
}

function num(description: string): JsonObject {
  return { type: 'number', description }
}

function viewTool(browser: BrowserProDriver): Tool {
  return {
    spec: {
      name: 'browser_view',
      description:
        "Change how your browser presents itself, then reload the page so the site sees it. mode desktop (1440x900), tablet (820x1180, touch) or phone (390x844, touch, mobile user agent and client hints), or fit (the panel's own size). Any width and height or aspect ratio works independently of the small panel: the page is laid out at that size and drawn scaled down to fit. Use it when a site is broken, says your browser or device is not supported, hides what you need behind a mobile layout, or needs a bigger window. It is remembered for the site; asDefault also makes it the starting view for sites you have not seen. reset goes back to the default.",
      schema: schema([], {
        mode: enumOf('Device to present as', 'desktop', 'tablet', 'phone', 'fit'),
        width: int('Viewport width in CSS pixels (200 to 4000)'),
        height: int('Viewport height in CSS pixels (200 to 4000)'),
        aspect: str('Aspect ratio instead of a height, for example 16:9 or 9:16'),
        zoom: num('Page zoom, 1 is normal; 0.8 fits more on the page'),
        dpr: num('devicePixelRatio the page sees, for example 1, 2 or 3'),
        touch: bool('Touch input on or off'),
        userAgent: str('A user agent to send instead of the device default'),
        asDefault: bool('Also use this for sites not learned yet'),
        remember: bool('Remember for this site (default true)'),
        reset: bool('Back to the default view and forget this site\'s view'),
      }),
    },
    run: async (input) => {
      const request: ViewRequest = {}
      if (input['mode'] !== undefined && input['mode'] !== null && input['mode'] !== '') {
        const mode = viewModeOf(input['mode'])
        if (mode === null) return 'mode is desktop, tablet, phone or fit.'
        request.mode = mode
      }
      const width = number(input['width'])
      const height = number(input['height'])
      const zoom = number(input['zoom'])
      const dpr = number(input['dpr'])
      if (width !== null) request.width = width
      if (height !== null) request.height = height
      if (zoom !== null) request.zoom = zoom
      if (dpr !== null) request.dpr = dpr
      if (typeof input['aspect'] === 'string' && input['aspect'].trim() !== '') request.aspect = input['aspect']
      if (typeof input['touch'] === 'boolean') request.touch = input['touch']
      if (typeof input['userAgent'] === 'string') request.userAgent = input['userAgent']
      if (input['asDefault'] === true) request.asDefault = true
      if (input['remember'] === false) request.remember = false
      if (input['reset'] === true) request.reset = true
      if (Object.keys(request).length === 0) return 'Pass a mode, a size, a zoom, or reset.'
      return call(() => browser.view(request))
    },
  }
}

function fixTool(browser: BrowserProDriver): Tool {
  return {
    spec: {
      name: 'browser_fix',
      description:
        "Fix the current site on the fly; fixes are kept and applied on every later visit. css: insert CSS (hide a cookie wall or overlay that eats clicks, force a layout). js: run a script on the page (once, unless persist is true; to look around or test use browser_eval, and never keep a script that adds anything visible). clear_data: wipe the site's cookies, storage, caches and service workers and reload (a stuck sign-in, a broken saved state). headers: extra request headers, one 'Name: value' per line (an empty value removes one). user_agent: a different user agent for this site. retry: load the page again as the other kind of device (desktop or phone) and remember the one that works. forget: drop everything learned about the site. list: what is known about every site.",
      schema: schema(['action'], {
        action: enumOf('What to do', ...FIXES),
        css: str('CSS for action css'),
        js: str('JavaScript for action js'),
        headers: str("For action headers: one 'Name: value' per line"),
        userAgent: str('For action user_agent'),
        persist: bool('Keep it for later visits. CSS is kept unless false; a script only when true. Keep only a real, tested fix that shows nothing extra on the page.'),
      }),
    },
    run: async (input) => {
      const action = text(input['action']).trim() as FixAction
      if (!FIXES.includes(action)) return `action is one of ${FIXES.join(', ')}.`
      const css = text(input['css'])
      const js = text(input['js'])
      if (css.length > MAX_SCRIPT || js.length > MAX_SCRIPT) return 'That fix is too long.'
      const headers = parseHeaders(text(input['headers']))
      if (action === 'headers' && headers === null) return "Write headers as 'Name: value', one per line."
      return call(() =>
        browser.fix({
          action,
          ...(css === '' ? {} : { css }),
          ...(js === '' ? {} : { js }),
          ...(headers === null ? {} : { headers }),
          ...(typeof input['userAgent'] === 'string' ? { userAgent: input['userAgent'] } : {}),
          // CSS is kept by default (it fixes how a site looks). A script is kept only when the agent says so:
          // a probe it wrote to look around must never run on every later visit.
          ...(action === 'js' ? { persist: input['persist'] === true } : input['persist'] === false ? { persist: false } : {}),
        }),
      )
    },
  }
}

function snapshotTool(browser: BrowserProDriver): Tool {
  return {
    spec: {
      name: 'browser_snapshot',
      description:
        'Read the page as numbered elements with role, name and state (checked, expanded, disabled, value), plus headings, open dialogs and cross-origin frames. Use filter on big pages. deep also numbers unlabelled clickable things (icon buttons, calendar cells, chips built as div). Then act by name with browser_act.',
      schema: schema([], {
        filter: str('Only elements whose name, role or link contains this'),
        deep: bool('Also find unlabelled clickable elements'),
      }),
    },
    run: async (input) => {
      const filter = text(input['filter']).trim()
      return call(() =>
        browser.snapshotPro({
          ...(filter === '' ? {} : { filter }),
          ...(input['deep'] === true ? { deep: true } : {}),
        }),
      )
    },
  }
}

function actTool(browser: BrowserProDriver): Tool {
  return {
    spec: {
      name: 'browser_act',
      description:
        "Act on the page with trusted input (real mouse and keyboard events, which hard sites require). Target by name as the snapshot prints it (best: it is found again live, so it survives re-renders), add role to tell a button from a link, nth when several share a name; or by index from the snapshot; or at_x/at_y in screenshot pixels for canvases, maps and cross-origin frames. Actions: click, double_click, right_click, type (replaces the field's text, submit presses Enter), select (an option in a dropdown, by its text), check, uncheck, hover, focus, press (key: Enter, Tab, Escape, Backspace, ArrowDown, PageDown, ctrl+a and so on), hold (ms), drag (to_x/to_y), scroll (dy). It waits for the element to be visible, enabled and still, and warns when something covers it. A click delivered is not a click that worked: read the result.",
      schema: schema(['action'], {
        action: enumOf('What to do', ...ACTIONS),
        name: str('The element name as the snapshot shows it'),
        role: str('button, link, textbox, checkbox, combobox, tab, menuitem, option...'),
        nth: int('Which one when several match, 1 is the first'),
        index: int('Element number from the snapshot'),
        text: str('Text to type, or the option to select'),
        submit: bool('Press Enter after typing'),
        key: str('Key for press'),
        at_x: int('X in screenshot pixels'),
        at_y: int('Y in screenshot pixels'),
        to_x: int('Drag target X in screenshot pixels'),
        to_y: int('Drag target Y in screenshot pixels'),
        ms: int('How long to hold, in milliseconds'),
        dy: int('Scroll amount in pixels, negative scrolls up'),
      }),
    },
    run: async (input) => {
      const action = text(input['action']).trim() as ActAction
      if (!ACTIONS.includes(action)) return `action is one of ${ACTIONS.join(', ')}.`
      const index = number(input['index'])
      const nth = number(input['nth'])
      const atX = number(input['at_x'])
      const atY = number(input['at_y'])
      const toX = number(input['to_x'])
      const toY = number(input['to_y'])
      const ms = number(input['ms'])
      const dy = number(input['dy'])
      const name = text(input['name']).trim()
      const role = text(input['role']).trim()
      const typed = text(input['text'])
      if (typed.length > 8_000) return 'That text is too long for one field.'
      if ((atX === null) !== (atY === null)) return 'Pass both at_x and at_y.'
      return call(() =>
        browser.act({
          action,
          ...(index === null ? {} : { index: Math.floor(index) }),
          ...(name === '' ? {} : { name }),
          ...(role === '' ? {} : { role }),
          ...(nth === null ? {} : { nth: Math.floor(nth) }),
          ...(input['text'] === undefined ? {} : { text: typed }),
          ...(input['submit'] === true ? { submit: true } : {}),
          ...(typeof input['key'] === 'string' ? { key: input['key'] } : {}),
          ...(atX === null || atY === null ? {} : { at: { x: atX, y: atY } }),
          ...(toX === null || toY === null ? {} : { to: { x: toX, y: toY } }),
          ...(ms === null ? {} : { ms }),
          ...(dy === null ? {} : { dy }),
        }),
      )
    },
  }
}

function evalTool(browser: BrowserProDriver): Tool {
  return {
    spec: {
      name: 'browser_eval',
      description:
        "Run JavaScript in the page itself (its own globals and framework state) and get back the value and a log. Pass an expression, or statements that end with return. For a multi-step flow write ONE script that does the whole thing and log() each stage: helpers log(...), sleep(ms), $(sel), $$(sel), waitFor(fn, ms) and setValue(el, value) (works with React). Read what failed in the log, fix that step, run again. Waits up to seconds (default 30, at most 120); for longer work start it without awaiting and poll window.__agentLog. Inspect before you click: dump the candidates' href, text and attributes when a click does nothing.",
      schema: schema(['js'], {
        js: str('The script'),
        seconds: int('How long to wait for it, default 30'),
      }),
    },
    run: async (input, ctx) => {
      const js = text(input['js'])
      if (js.trim() === '') return 'Pass the script in js.'
      if (js.length > MAX_SCRIPT) return 'That script is too long.'
      const seconds = number(input['seconds']) ?? 30
      return call(() => browser.evaluate(js, Math.max(1, Math.min(120, Math.floor(seconds))), ctx.signal))
    },
  }
}

/** "Name: value" per line. Null when a line is not a header. */
export function parseHeaders(raw: string): Record<string, string> | null {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  if (lines.length === 0) return null
  const out: Record<string, string> = {}
  for (const line of lines) {
    const at = line.indexOf(':')
    if (at <= 0) return null
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

async function call(action: () => Promise<string>): Promise<string> {
  try {
    return await action()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `The browser had a problem: ${message}`
  }
}

function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim())
  return null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
