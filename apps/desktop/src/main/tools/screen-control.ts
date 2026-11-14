/**
 * screen_windows, screen_read, screen_act (11 Nov 2026): work in any program on this computer WITHOUT moving his mouse,
 * pressing keys on his foreground window or taking his focus. See agent-cursor/control.ts for the ladder.
 */
import { bool, enumOf, int, schema, str, type Tool } from '@agent/core'

import type { ScreenActAnswer, ScreenActRequest, ScreenControl, ScreenReadAnswer, ScreenWindow } from '../agent-cursor/control'

/** The part of agent-cursor/control.ts the tools use. */
export type ScreenControlHost = Pick<ScreenControl, 'windows' | 'read' | 'act'>

export interface ScreenControlToolDeps {
  /** Absent on a device with no screen of his (a headless node), or when the helper cannot run here. */
  control?: () => ScreenControlHost | null
}

const NO_SCREEN = 'Working in other programs needs the computer he is at (Windows), and this device cannot do it.'

const ACTIONS = ['click', 'double_click', 'right_click', 'type', 'set_value', 'toggle', 'select', 'expand', 'collapse', 'scroll', 'key'] as const

const WHICH = {
  hwnd: str('The window, from screen_windows (preferred)'),
  title: str('Or part of its title'),
  process: str('Or its process name, e.g. notepad'),
}

export function windowLine(w: ScreenWindow): string {
  const flags = [w.minimised ? 'minimised' : '', w.integrity === 'elevated' ? 'administrator' : '', w.needs !== null ? 'needs the agent desktop' : ''].filter((f) => f !== '')
  return w.hwnd + ' | ' + w.process + ' | ' + w.className + ' | "' + w.title.slice(0, 80) + '" | ' + w.rect.x + ',' + w.rect.y + ' ' + w.rect.width + 'x' + w.rect.height + (flags.length === 0 ? '' : ' | ' + flags.join(', '))
}

export function readText(a: ScreenReadAnswer): string {
  const lines = ['Window ' + windowLine(a.window), 'Elements (' + a.elements.length + ' of ' + a.seen + ' seen; @x,y is the place on screen):']
  for (const e of a.elements) lines.push('- ' + e.role + ' "' + e.name + '"' + (e.value === undefined ? '' : ' = "' + e.value + '"') + (e.enabled ? '' : ' (disabled)') + ' @' + e.rect.x + ',' + e.rect.y + ' ' + e.rect.width + 'x' + e.rect.height)
  if (a.picture !== undefined) lines.push(a.pictureHow === 'window' ? 'Picture taken off screen (the window itself, even if something covers it):' : 'Picture of the screen area (the window refused an off-screen picture, so what is on top of it shows):', '[[image:' + a.picture + ']]')
  return lines.join('\n')
}

export function actText(a: ScreenActAnswer): string {
  const lines = [(a.ok ? 'OK ' : 'NOT DONE ') + (a.code === undefined ? '' : '[' + a.code + '] ') + a.message]
  if (a.rung !== undefined) lines.push('rung: ' + a.rung + (a.evidence === undefined ? '' : ' (verified by ' + a.evidence + ')'))
  if (a.tried !== undefined && a.tried.length > 0) lines.push('tried: ' + a.tried.map((t) => t.rung + ' ' + t.result).join('; '))
  if (a.element !== undefined) lines.push('element: ' + a.element + (a.value === undefined ? '' : ' = "' + a.value + '"'))
  if (a.note !== undefined) lines.push('note: ' + a.note)
  lines.push('his pointer ' + (a.his.cursorMoved ? 'MOVED' : 'unchanged') + ', his foreground window ' + (a.his.foregroundChanged ? 'CHANGED' : 'unchanged') + (a.focus?.taken === true ? ' (the program took the front for ' + a.focus.lostMs + ' ms, then his window was ' + (a.focus.givenBack ? 'given back' : 'NOT given back') + ')' : ''))
  return lines.join('\n')
}

const failed = (what: string, error: unknown): string => what + ': ' + (error instanceof Error ? error.message : String(error))

export function screenControlTools(deps: ScreenControlToolDeps): Tool[] {
  const host = (): ScreenControlHost | null => deps.control?.() ?? null
  return [
    {
      spec: {
        name: 'screen_windows',
        description:
          'List the windows open on this computer (every program, not only the browser): handle, process, class, title, position and size, and whether it is minimised, runs as administrator or needs the agent desktop. Reads only; nothing is touched, moved or brought forward. Use the handle in screen_read and screen_act.',
        schema: schema([], {}),
      },
      run: async () => {
        const control = host()
        if (control === null) return NO_SCREEN
        try {
          const all = await control.windows()
          return all.length === 0 ? 'No windows found.' : all.map(windowLine).join('\n')
        } catch (error) {
          return failed('Could not list windows', error)
        }
      },
    },
    {
      spec: {
        name: 'screen_read',
        description:
          'Read one window: its usable controls by name and role with their place (UI Automation), optionally a picture of it. The picture is taken off screen, so a window that is covered or behind others can still be read. Reads only: his mouse, keyboard and focus are untouched. Filter to find a control; read again after screen_act to see what changed.',
        schema: schema([], {
          ...WHICH,
          filter: str('Only elements whose name, role or value contain this'),
          everything: bool('All named elements, not only the usable ones'),
          max: int('Most elements to list, default 250'),
          picture: bool('Also a picture of the window'),
        }),
      },
      run: async (input) => {
        const control = host()
        if (control === null) return NO_SCREEN
        try {
          const answer = await control.read({
            ...(typeof input['hwnd'] === 'string' ? { hwnd: input['hwnd'] } : {}),
            ...(typeof input['title'] === 'string' ? { title: input['title'] } : {}),
            ...(typeof input['process'] === 'string' ? { process: input['process'] } : {}),
            ...(typeof input['filter'] === 'string' ? { filter: input['filter'] } : {}),
            ...(input['everything'] === true ? { everything: true } : {}),
            ...(typeof input['max'] === 'number' ? { max: input['max'] } : {}),
            ...(input['picture'] === true ? { picture: true } : {}),
          })
          return 'error' in answer ? '[' + answer.code + '] ' + answer.error : readText(answer)
        } catch (error) {
          return failed('Could not read that window', error)
        }
      },
    },
    {
      spec: {
        name: 'screen_act',
        description:
          "Click, type, set a value, toggle, select, expand, scroll or press a key in ONE window, without moving his mouse, pressing keys on his foreground window or taking his focus. Target by element name and role (from screen_read) or by x,y pixels inside the window. It tries, in order: window messages for text, UI Automation patterns, the page debugger for browsers and Electron apps, posted mouse and key messages, then the agent desktop; and says which way worked, checked against what changed. A program that ignores posted input is reported as ignoring it: say so, do not retry. 'Needs the agent desktop' means posted input cannot reach it (remote viewers, games, administrator windows). real_input is a last resort: it only works when he allowed it in Settings, tells him first, waits until he is idle and stops when he touches anything.",
        schema: schema(['action'], {
          ...WHICH,
          action: enumOf('What to do', ...ACTIONS),
          name: str('The element, as screen_read names it'),
          role: str('button, textbox, checkbox, combobox, menuitem, tab, listitem (optional)'),
          nth: int('Which one when several share the name, 1 is the first'),
          x: int('Pixels from the window left, when there is no named element'),
          y: int('Pixels from the window top'),
          text: str('The text to type or set. A vault [vault:vercel-recovery-past952.token] works and is never shown'),
          key: str('A key with modifiers, e.g. Enter, Escape, ctrl+s, alt+f4'),
          dy: int('Scroll amount in pixels, negative scrolls up'),
          state: str('For toggle: on or off'),
          append: bool('type: add to what is there instead of replacing it'),
          real_input: bool('Last resort only, see above'),
        }),
      },
      run: async (input, ctx) => {
        const control = host()
        if (control === null) return NO_SCREEN
        const action = ACTIONS.find((a) => a === input['action'])
        if (action === undefined) return 'Say the action: ' + ACTIONS.join(', ') + '.'
        const request: ScreenActRequest = {
          action,
          ...(typeof input['hwnd'] === 'string' ? { hwnd: input['hwnd'] } : {}),
          ...(typeof input['title'] === 'string' ? { title: input['title'] } : {}),
          ...(typeof input['process'] === 'string' ? { process: input['process'] } : {}),
          ...(typeof input['name'] === 'string' ? { name: input['name'] } : {}),
          ...(typeof input['role'] === 'string' ? { role: input['role'] } : {}),
          ...(typeof input['nth'] === 'number' ? { nth: input['nth'] } : {}),
          ...(typeof input['x'] === 'number' ? { x: input['x'] } : {}),
          ...(typeof input['y'] === 'number' ? { y: input['y'] } : {}),
          ...(typeof input['text'] === 'string' ? { text: input['text'] } : {}),
          ...(typeof input['key'] === 'string' ? { key: input['key'] } : {}),
          ...(typeof input['dy'] === 'number' ? { dy: input['dy'] } : {}),
          ...(typeof input['state'] === 'string' ? { state: input['state'] } : {}),
          ...(input['append'] === true ? { append: true } : {}),
          ...(input['real_input'] === true ? { realInput: true } : {}),
          owner: ctx.owner ?? ctx.agentLabel,
          signal: ctx.signal,
        }
        try {
          const answer = await control.act(request)
          await ctx.activity((answer.ok ? 'Did ' : 'Tried ') + action + (request.name === undefined ? '' : ' "' + request.name + '"') + (answer.rung === undefined ? '' : ' via ' + answer.rung), { tool: 'screen_act' })
          return actText(answer)
        } catch (error) {
          return failed('The action had a problem', error)
        }
      },
    },
  ]
}
