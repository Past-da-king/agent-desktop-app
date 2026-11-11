/**
 * Rung 5 of the ladder: the agent's own desktop (tools/agent-desktop, docs/agent-desktop.md) behind the agent_desktop tool.
 * One desktop for the app; it is created on the first `open`/`launch` and closed with `close` or at app quit. Every sidecar
 * reply says whether his cursor or foreground moved; if either did, the answer says so loudly.
 *
 * Not built: the viewer window (Watch, Take over, Give back). Listed as open in docs/agent-cursor.md.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { createAgentSurface, type AgentSurface, type SurfaceResult } from '../agent-desktop/agent-surface'

export interface DesktopRequest {
  op: string
  app?: string
  args?: string
  window?: number
  x?: number
  y?: number
  text?: string
}

export interface DesktopDeps {
  lookup: () => { resourcesPath?: string; dirs: string[] }
  dir: () => string
  /** For tests. */
  surface?: () => AgentSurface
  exists?: (path: string) => boolean
}

/** `<resources>/agent-desktop/agent-desktop.exe`, else tools/agent-desktop/bin/win-x64 under each folder. */
export function findDesktopSidecar(lookup: { resourcesPath?: string; dirs: string[] }, exists: (p: string) => boolean = existsSync, env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: string[] = []
  const fromEnv = env['AGENT_DESKTOP_PATH']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') candidates.push(fromEnv.trim())
  if (lookup.resourcesPath !== undefined && lookup.resourcesPath !== '') candidates.push(join(lookup.resourcesPath, 'agent-desktop', 'agent-desktop.exe'))
  for (const dir of lookup.dirs) candidates.push(join(dir, 'tools', 'agent-desktop', 'bin', 'win-x64', 'agent-desktop.exe'))
  return candidates.find((p) => exists(p)) ?? null
}

function guardNote(r: SurfaceResult): string {
  return r.cursorMoved || r.foregroundChanged ? ` WARNING: ${r.cursorMoved ? 'his cursor moved' : ''}${r.cursorMoved && r.foregroundChanged ? ' and ' : ''}${r.foregroundChanged ? 'his foreground window changed' : ''} during this step. Stop and tell him.` : ''
}

export class AgentDesktop {
  private deps: DesktopDeps
  private surface: AgentSurface | null = null
  private opened = false

  constructor(deps: DesktopDeps) {
    this.deps = deps
  }

  private get(): AgentSurface {
    if (this.surface !== null) return this.surface
    if (this.deps.surface !== undefined) {
      this.surface = this.deps.surface()
      return this.surface
    }
    const exe = findDesktopSidecar(this.deps.lookup(), this.deps.exists)
    if (exe === null) throw new Error('The agent desktop helper (agent-desktop.exe) is missing from this install.')
    this.surface = createAgentSurface(exe)
    return this.surface
  }

  private async ensureOpen(): Promise<void> {
    if (this.opened) return
    const r = await this.get().open()
    if (!r.ok) throw new Error(r.error ?? 'The agent desktop could not be made.')
    this.opened = true
  }

  async run(request: DesktopRequest): Promise<string> {
    switch (request.op) {
      case 'open': {
        await this.ensureOpen()
        return 'The agent desktop is ready. His screen is unchanged. Start a program with launch.'
      }
      case 'launch': {
        if (request.app === undefined || request.app === '') return 'launch needs app: the full path of an exe.'
        await this.ensureOpen()
        const r = await this.get().launch(request.app, request.args)
        return r.ok ? `Started (pid ${String(r.pid)}) on the agent desktop. Use op windows to find its window.${guardNote(r)}` : `Could not start it: ${r.error ?? 'unknown'}. A packaged app (new Notepad, Paint, Store apps) cannot be started on a separate desktop; use a classic exe.`
      }
      case 'windows': {
        await this.ensureOpen()
        const list = await this.get().windows()
        return list.length === 0 ? 'No windows on the agent desktop yet.' : list.map((w) => `${w.hwnd}  "${w.title}"  ${w.w}x${w.h}`).join('\n')
      }
      case 'capture': {
        if (request.window === undefined) return 'capture needs window.'
        await this.ensureOpen()
        const dir = this.deps.dir()
        mkdirSync(dir, { recursive: true })
        const path = join(dir, `desk-${request.window}-${Date.now()}.png`)
        const r = await this.get().capture(request.window, path)
        return r.ok ? `[[image:${path}]]${guardNote(r)}` : `Could not capture: ${r.error ?? 'unknown'}`
      }
      case 'click': {
        if (request.window === undefined || request.x === undefined || request.y === undefined) return 'click needs window, x and y.'
        await this.ensureOpen()
        const r = await this.get().click(request.window, request.x, request.y)
        return r.ok ? `Clicked inside the window (posted, not his mouse). Capture again to see the effect; it is not verified here.${guardNote(r)}` : `Click failed: ${r.error ?? 'unknown'}`
      }
      case 'type': {
        if (request.window === undefined || request.text === undefined) return 'type needs window and text.'
        await this.ensureOpen()
        const r = await this.get().type(request.window, request.text)
        return r.ok ? `Typed ${request.text.length} characters (posted to the window). Capture to check; it is not verified here.${guardNote(r)}` : `Typing failed: ${r.error ?? 'unknown'}`
      }
      case 'close': {
        if (this.surface === null) return 'Nothing was open.'
        const r = await this.surface.close()
        this.opened = false
        this.surface = null
        return r.ok ? 'The agent desktop is closed and what it started is stopped.' : `Closing had a problem: ${r.error ?? 'unknown'}`
      }
      default:
        return 'op must be open, launch, windows, capture, click, type or close.'
    }
  }

  async close(): Promise<void> {
    if (this.surface !== null) await this.run({ op: 'close' })
  }
}
