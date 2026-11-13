/**
 * agent_desktop (11 Nov 2026): the agent's OWN desktop, a screen he never sees, for classic Windows programs that ignore
 * posted input. Rung 5 of the ladder in docs/agent-cursor.md. Logic in main/agent-cursor/desktop.ts; the helper and its
 * limits in docs/agent-desktop.md. Never his mouse, keyboard or focus.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { int, schema, str, type Tool } from '@agent/core'

import { AgentDesktop } from '../agent-cursor/desktop'

let desktop: AgentDesktop | null = null

function lookup(): { resourcesPath?: string; dirs: string[] } {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  const cwd = process.cwd()
  return { ...(typeof resourcesPath === 'string' ? { resourcesPath } : {}), dirs: [cwd, join(cwd, '..', '..')] }
}

function get(): AgentDesktop {
  if (desktop === null) desktop = new AgentDesktop({ lookup, dir: () => join(tmpdir(), 'agent-desktop-shots') })
  return desktop
}

/** App quit: kill what the agent desktop started and close it. */
export function disposeAgentDesktop(): void {
  const d = desktop
  desktop = null
  void d?.close().catch(() => undefined)
}

export function agentDesktopTools(): Tool[] {
  if (process.platform !== 'win32') return []
  return [
    {
      spec: {
        name: 'agent_desktop',
        description:
          "The agent's OWN desktop, a screen he never sees, for classic Windows programs that ignore posted input (screen_act says 'needs the agent desktop'). Never his mouse, keyboard or focus. op: open, launch (app = full path of an exe, args), windows, capture (window number; returns a picture), click (window, x, y inside the window), type (window, text), close (stops what it started). Chrome, Edge and Electron pages come out black here: use screen_act (page debugger) for those. Packaged Store apps (new Notepad, Paint) cannot be started here.",
        schema: schema(['op'], {
          op: str('open, launch, windows, capture, click, type or close'),
          app: str('launch: full path of the program'),
          args: str('launch: its arguments'),
          window: int('The window number from op windows'),
          x: int('click: pixels from the window left'),
          y: int('click: pixels from the window top'),
          text: str('type: the text'),
        }),
      },
      run: async (input) => {
        try {
          return await get().run({
            op: String(input['op'] ?? ''),
            ...(typeof input['app'] === 'string' ? { app: input['app'] } : {}),
            ...(typeof input['args'] === 'string' ? { args: input['args'] } : {}),
            ...(typeof input['window'] === 'number' ? { window: input['window'] } : {}),
            ...(typeof input['x'] === 'number' ? { x: input['x'] } : {}),
            ...(typeof input['y'] === 'number' ? { y: input['y'] } : {}),
            ...(typeof input['text'] === 'string' ? { text: input['text'] } : {}),
          })
        } catch (error) {
          return `The agent desktop could not do that: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    },
  ]
}
