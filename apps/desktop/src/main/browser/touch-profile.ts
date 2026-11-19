/**
 * What the agent's pages see of touch (20 Nov 2026).
 *
 * A desktop view must report no touch at all, even on a PC with a touchscreen. Measured: a real touchscreen gives
 * maxTouchPoints 10 and `ontouchstart`, and PowerPoint for the web then opens its phone reading view ("Open in
 * app") from a direct link. `Emulation.setTouchEmulationEnabled { enabled: false }` only switches the emulation
 * off: the hardware still shows through. And `Emulation.setEmulatedMedia` ignores pointer, hover, any-pointer and
 * any-hover (measured on Electron 44: the page keeps `(pointer: coarse)` while touch is emulated). So the desktop
 * profile is the touch emulation off plus a small script, run before the page's own scripts in the page and in
 * every frame (a cross-site frame has a session of its own), that removes what the hardware adds.
 *
 * A phone or tablet view (or an explicit touch override) is the opposite: the script is taken out and
 * `emulationCommands` turns the touch emulation on, as before. Never a list of sites.
 *
 * Pure apart from the link it is handed, so it is tested without Electron.
 */
import type { ViewSpec } from './emulation'

/** What a view's touch profile is. */
export type TouchProfile = 'desktop' | 'touch'

export function touchProfileOf(view: Pick<ViewSpec, 'touch'>): TouchProfile {
  return view.touch ? 'touch' : 'desktop'
}

/** Runs in every frame of a desktop view, before the page's scripts. Plain closures; nothing is left on the window. */
export const NO_TOUCH_SCRIPT = `(() => {
  try {
    const own = (target, name) => Object.getOwnPropertyDescriptor(target, name);
    // navigator.maxTouchPoints: 0, as a getter on the prototype where Chrome has it.
    const points = own(Navigator.prototype, 'maxTouchPoints');
    if (points && points.configurable) {
      const read = function () { return 0; };
      Object.defineProperty(read, 'name', { value: 'get maxTouchPoints' });
      Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: read, set: undefined, enumerable: points.enumerable, configurable: true });
    }
    // The touch event handler properties exist only on a touch device: take them off everything that carries them.
    const names = ['ontouchstart', 'ontouchend', 'ontouchmove', 'ontouchcancel'];
    for (const target of [window, Window.prototype, Document.prototype, HTMLElement.prototype, SVGElement.prototype, Element.prototype]) {
      for (const name of names) {
        const d = own(target, name);
        if (d && d.configurable) delete target[name];
      }
    }
  } catch (e) {}
})();`

/** The part of the debugger this needs. */
export interface TouchLink {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>
  onEvent(listener: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void
}

/**
 * Keeps one tab's desktop touch profile in the page and in each cross-site frame's session, as frames come and go
 * and as the view changes between desktop and touch.
 */
export class TouchProfileHost {
  /** The script's registration per session ('' is the page), while it is on. */
  private readonly scripts = new Map<string, string | null>()
  private readonly frames = new Set<string>()
  private desktop = false
  private readonly off: () => void
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly link: TouchLink) {
    this.off = link.onEvent((method, params, rawSession) => {
      if (method === 'Target.attachedToTarget') {
        const info = (params['targetInfo'] ?? {}) as Record<string, unknown>
        const sid = typeof params['sessionId'] === 'string' ? params['sessionId'] : ''
        if (sid === '' || info['type'] !== 'iframe') return
        this.frames.add(sid)
        // A frame in a frame is attached to by its own session.
        void link.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe' }] }, sid).catch(() => undefined)
        if (this.desktop) this.enqueue(() => this.put(sid))
      } else if (method === 'Target.detachedFromTarget') {
        const sid = typeof params['sessionId'] === 'string' ? params['sessionId'] : ''
        this.frames.delete(sid)
        this.scripts.delete(sid)
      }
      void rawSession
    })
  }

  stop(): void {
    this.off()
  }

  /** Makes the page and every frame follow `profile`. Attaches to cross-site frames when the profile is desktop. */
  async apply(profile: TouchProfile): Promise<void> {
    this.desktop = profile === 'desktop'
    if (this.desktop) {
      await this.link.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe' }] }).catch(() => undefined)
    }
    await this.enqueue(async () => {
      for (const sid of ['', ...this.frames]) {
        if (this.desktop) await this.put(sid)
        else await this.take(sid)
      }
    })
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.queue.then(job, job).catch(() => undefined)
    this.queue = next
    return next
  }

  private async put(sid: string): Promise<void> {
    if (this.scripts.get(sid) !== undefined && this.scripts.get(sid) !== null) return
    const session = sid === '' ? undefined : sid
    await this.link.send('Page.enable', {}, session).catch(() => undefined)
    try {
      const out = (await this.link.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_TOUCH_SCRIPT, runImmediately: true }, session)) as { identifier?: string } | undefined
      this.scripts.set(sid, out?.identifier ?? null)
    } catch {
      // A session that went away is not worth failing the view for.
    }
  }

  private async take(sid: string): Promise<void> {
    const id = this.scripts.get(sid)
    this.scripts.delete(sid)
    if (typeof id !== 'string') return
    await this.link.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id }, sid === '' ? undefined : sid).catch(() => undefined)
  }
}
