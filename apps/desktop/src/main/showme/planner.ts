/**
 * What the small model is asked during a walk, and how its answers are read ("show me how", 10 Nov 2026).
 *
 *   - plan:   question + the matching skill + what is on screen now  ->  the ordered steps (one call, at the start,
 *             and again only when the screen surprised the walk);
 *   - pick:   one step + the elements on screen                      ->  which element it is (only when the step's
 *             own name did not find it);
 *   - locate: one step + a picture of the window                     ->  a box (the last resort, when the program
 *             exposes no elements at all).
 *
 * Privacy: an element's value (what is typed in a field) is never put in a prompt, only its role, name and place.
 * Pure text in, parsed data out, so all of it is tested without a model.
 */
import type { ActiveWindow, Rect, UiNode } from './screen'

export interface ShowStep {
  /** What he should do, a few words: "Click Create Pixel". */
  label: string
  /** The element's name as the screen shows it. */
  name: string
  role?: string
  nth?: number
  /** Clipboard fill: what goes in this field. */
  value?: string
  sensitive?: boolean
}

export const MAX_STEPS = 20
export const MAX_NODES = 160

/** The elements as a model reads them: one per line, "id | role | name | where". Never a value. */
export function formatNodes(nodes: UiNode[], max = MAX_NODES): string {
  const lines: string[] = []
  for (const node of nodes) {
    if (node.offscreen || node.name.trim() === '') continue
    lines.push(`${node.id} | ${node.role} | ${clip(node.name, 80)}${node.path === '' ? '' : ` | ${clip(node.path, 60)}`}${node.enabled ? '' : ' | disabled'}`)
    if (lines.length >= max) break
  }
  return lines.length === 0 ? '(no named elements can be read in this window)' : lines.join('\n')
}

function windowLine(window: Pick<ActiveWindow, 'process' | 'title' | 'url'>): string {
  return `Window: ${clip(window.title, 120) || '(untitled)'} [${window.process}]${window.url === undefined || window.url === '' ? '' : ` at ${clip(window.url, 200)}`}`
}

export const PLAN_SYSTEM = [
  'You guide a person through a task on their own computer. They do every click themselves: you only say what to use next, one thing at a time, and a ring is drawn on it.',
  'You get their question, the window they are on, the named elements on screen now, and sometimes a skill page that already describes the route. When there is a skill page, follow its route and wording; do not invent another.',
  'Reply with JSON only, no prose and no code fence: {"steps":[{"label":"Click Create pixel","name":"Create pixel","role":"button"}],"note":""}',
  'Rules for steps:',
  '- One action per step, in order, at most 12. Start from what is on screen NOW, not from a home page.',
  '- In a skill page, a name in `backticks` or quotes is the exact name of an element: use it as the step name, letter for letter. A path like /settings is an address, not something to click; when the page says a place only opens from a menu, plan the clicks that open it.',
  '- name is the element exactly as the screen shows it. For the first steps use a name from the list. Later steps are on screens you cannot see yet: use the name the skill page gives, or the most likely visible text.',
  '- role is one of button, link, textbox, checkbox, combobox, tab, menuitem, listitem, or left out when unsure. nth (1 = first) only when several share the name.',
  '- label is a few plain words that start with a verb. No emoji.',
  '- A step that types into a field gets "value" only when the value is known from the question or the skill page. Never invent a value, and never put a password or key in value.',
  '- If the task cannot be done from this window, reply {"steps":[],"note":"one short line saying where to go first"}.',
].join('\n')

export interface PlanInput {
  question: string
  window: Pick<ActiveWindow, 'process' | 'title' | 'url'>
  nodes: UiNode[]
  /** The matching skill page or learned app, as text ('' = none). */
  skill: string
  /** On a re-plan: the labels he has already done, and what could not be found. */
  done?: string[]
  missing?: string
}

export function planPrompt(input: PlanInput): string {
  return [
    `Question: ${clip(input.question, 600)}`,
    windowLine(input.window),
    input.skill.trim() === '' ? 'Skill page: none. Plan from the screen and what you know of this program.' : `Skill page (the route to follow):\n${input.skill}`,
    input.done !== undefined && input.done.length > 0 ? `Already done by the person, in order: ${input.done.map((label) => `"${clip(label, 60)}"`).join(', ')}. Plan only what is left.` : '',
    input.missing !== undefined && input.missing !== '' ? `The earlier plan expected "${clip(input.missing, 80)}" next, and it is not on screen. Plan again from what IS on screen.` : '',
    `Elements on screen now (id | role | name | where):\n${formatNodes(input.nodes)}`,
  ]
    .filter((part) => part !== '')
    .join('\n\n')
}

/** The first JSON object in a reply, whatever is around it. */
function jsonIn(text: string): unknown {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as unknown
        } catch {
          return null
        }
      }
    }
  }
  return null
}

const ROLES = new Set(['button', 'link', 'textbox', 'checkbox', 'combobox', 'tab', 'menuitem', 'listitem', 'radio', 'treeitem', 'menu', 'text', 'image', 'slider', 'switch'])

/** One step from a model or from the tool's input, or null when it names nothing. */
export function stepFrom(raw: unknown): ShowStep | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const text = (key: string): string => (typeof o[key] === 'string' ? (o[key] as string).replace(/\s+/g, ' ').trim() : '')
  const name = text('name')
  if (name === '') return null
  const role = text('role').toLowerCase()
  const nth = typeof o['nth'] === 'number' && Number.isFinite(o['nth']) && o['nth'] > 0 ? Math.floor(o['nth']) : undefined
  const value = typeof o['value'] === 'string' ? o['value'] : typeof o['value'] === 'number' ? String(o['value']) : ''
  const label = clip(text('label') || (value !== '' ? `Fill in ${name}` : `Click ${name}`), 80)
  return {
    label,
    name: clip(name, 120),
    ...(role !== '' && ROLES.has(role) ? { role } : {}),
    ...(nth === undefined ? {} : { nth }),
    ...(value === '' || value.length > 4_000 ? {} : { value }),
    ...(value !== '' && o['sensitive'] === true ? { sensitive: true } : {}),
  }
}

export function parsePlan(reply: string): { steps: ShowStep[]; note: string } {
  const parsed = jsonIn(reply)
  if (parsed === null || typeof parsed !== 'object') return { steps: [], note: '' }
  const o = parsed as Record<string, unknown>
  const steps = (Array.isArray(o['steps']) ? o['steps'] : []).map(stepFrom).filter((step): step is ShowStep => step !== null).slice(0, MAX_STEPS)
  return { steps, note: typeof o['note'] === 'string' ? clip(o['note'], 160) : '' }
}

export const PICK_SYSTEM = [
  'A person is being guided through a task and must use one element next. From the list of elements on screen, pick the one this step means.',
  'Reply with the id only (the first column), nothing else. If none of them is it, reply NONE.',
].join('\n')

export function pickPrompt(step: ShowStep, window: Pick<ActiveWindow, 'process' | 'title' | 'url'>, nodes: UiNode[]): string {
  return [`Step: ${step.label}`, `Looking for: "${step.name}"${step.role === undefined ? '' : ` (${step.role})`}`, windowLine(window), `Elements on screen (id | role | name | where):\n${formatNodes(nodes)}`].join('\n\n')
}

export function parsePick(reply: string, nodes: UiNode[]): UiNode | null {
  const text = reply.trim()
  if (text === '' || /^none\b/i.test(text)) return null
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const whole = byId.get(text.replace(/^["'`]|["'`.]$/g, ''))
  if (whole !== undefined) return whole
  for (const token of text.split(/[\s|,;:"'`]+/)) {
    const hit = byId.get(token)
    if (hit !== undefined) return hit
  }
  return null
}

export const LOCATE_SYSTEM = [
  'You are shown a picture of a window. A person must use one thing in it next. Find it.',
  'Reply with JSON only: {"x":0,"y":0,"width":0,"height":0} in pixels of the picture (x, y is the top left of the thing). If it is not in the picture, reply {"none":true}.',
].join('\n')

export function locatePrompt(step: ShowStep, size: { width: number; height: number }): string {
  return `The picture is ${size.width} by ${size.height} pixels.\nStep: ${step.label}\nFind: "${step.name}"${step.role === undefined ? '' : ` (${step.role})`}`
}

/** The box a model answered, kept inside the picture, or null. */
export function parseBox(reply: string, size: { width: number; height: number }): Rect | null {
  const parsed = jsonIn(reply)
  if (parsed === null || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  if (o['none'] === true) return null
  const n = (key: string): number => (typeof o[key] === 'number' && Number.isFinite(o[key]) ? (o[key] as number) : Number.NaN)
  let x = n('x')
  let y = n('y')
  let width = n('width')
  let height = n('height')
  if ([x, y, width, height].some((value) => Number.isNaN(value)) || width <= 0 || height <= 0) return null
  // Some models answer in 0..1 of the picture.
  if (x <= 1 && y <= 1 && width <= 1 && height <= 1) {
    x *= size.width
    width *= size.width
    y *= size.height
    height *= size.height
  }
  x = Math.max(0, Math.min(x, size.width - 1))
  y = Math.max(0, Math.min(y, size.height - 1))
  width = Math.min(width, size.width - x)
  height = Math.min(height, size.height - y)
  if (width < 4 || height < 4) return null
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

/** A PNG's size from its header, or null when it is not one. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return null
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3)}...`
}
