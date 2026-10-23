/**
 * Learned apps run in the browser where their site is signed in, on whichever linked device that is.
 *
 * A learned app's tools run as JavaScript inside a signed-in page, so the device matters as much as the profile: a
 * helper offloaded to a server runs in the server's browser, which has none of the person's sign-ins. webapp_run and
 * webapp_test therefore take an optional `device`, and without one they pick it themselves:
 *  - here, when this device's browser is known to be signed in (the app ran here before, or the session holds site
 *    data for its address);
 *  - otherwise a linked device that is online, offers the tool, and is where the app last worked (LearnedApp.devices);
 *  - with no record at all and a browser here that cannot tell (a headless node), a linked computer that offers it;
 *  - else here, and the tool's own answer says what is wrong.
 * A run that worked here is recorded on the app, so the other devices know where it is signed in (the list travels in
 * the state bundle). A command that came from another device always runs here: it was already routed.
 */
import { MAIN_CHAT, type JsonObject, type Tool, type ToolContext } from '@agent/core'

import type { LearnedApp, LearnedStore } from '../apps/store'
import type { DeviceToolHub } from './device-tools'

export const LEARNED_RUN_TOOLS: ReadonlySet<string> = new Set(['webapp_run', 'webapp_test'])

export interface LearnedRouteDeps {
  learned: LearnedStore
  /** This device's id while Devices is on, '' while it is off. */
  selfId: () => string
  /**
   * Whether this device's browser (in the caller's profile partition) holds site data for an address; null when this
   * browser cannot tell (a headless node). Absent: cannot tell.
   */
  siteHere?: (url: string, ctx: ToolContext) => Promise<boolean | null>
}

/** The kinds of device that carry the person's own browser sign-ins. */
function personal(kind: string): boolean {
  return kind !== 'server' && kind !== 'phone' && kind !== 'tablet'
}

interface ListedDevice {
  id: string
  name: string
  kind: string
  online: boolean
  self: boolean
  tools: string[]
}

/** Where a learned tool should run: another device's id and name, or null for here. */
export async function learnedTarget(
  app: LearnedApp,
  tool: string,
  ctx: ToolContext,
  list: () => Promise<ListedDevice[]>,
  deps: Pick<LearnedRouteDeps, 'selfId' | 'siteHere'>,
): Promise<{ id: string; name: string } | null> {
  const owner = ctx.owner ?? ''
  if (owner === 'device' || owner.startsWith('device:')) return null
  const self = deps.selfId()
  if (self === '') return null
  const known = app.devices ?? []
  if (known.includes(self)) return null
  let here: boolean | null = null
  try {
    here = deps.siteHere === undefined ? null : await deps.siteHere(app.startUrl, ctx)
  } catch {
    here = null
  }
  if (here === true) return null
  let devices: ListedDevice[] = []
  try {
    devices = await list()
  } catch {
    return null
  }
  const able = devices.filter((d) => !d.self && d.online && d.tools.includes(tool))
  for (const id of [...known].reverse()) {
    const hit = able.find((d) => d.id === id)
    if (hit !== undefined) return { id: hit.id, name: hit.name }
  }
  if (known.length > 0 || here === false) return null
  const computer = able.find((d) => personal(d.kind))
  return computer === undefined ? null : { id: computer.id, name: computer.name }
}

/** A learned tool's answer that shows the page answered (not refused, declined or failed). */
export function learnedRanOk(out: string): boolean {
  return !/^(Error:|DECLINED|Missing input|No saved app|args must be)/.test(out) && !/ has no tool /.test(out.slice(0, 200)) && !/ is a learned app of /.test(out.slice(0, 300))
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** webapp_run and webapp_test with a `device` argument, run on the device where the app is signed in. */
export function withLearnedRoute(tools: Tool[], hub: () => DeviceToolHub | null, deps: LearnedRouteDeps): Tool[] {
  return tools.map((tool) => {
    const name = tool.spec.name
    if (!LEARNED_RUN_TOOLS.has(name)) return tool
    const props = (tool.spec.schema['properties'] ?? {}) as JsonObject
    return {
      spec: {
        ...tool.spec,
        schema: {
          ...tool.spec.schema,
          properties: {
            ...props,
            device: {
              type: 'string',
              description:
                "Optional: the linked device whose browser runs it (name or id). Leave out: the app picks the device where the app's site is signed in (this one when it is).",
            },
          },
        },
      },
      run: async (input, ctx) => {
        const named = str(input['device']).trim()
        const { device: _drop, ...rest } = input
        void _drop
        const active = hub()
        const app = deps.learned.find(str(rest['app']))
        let target: { id: string; name: string } | null = null
        if (active !== null && named !== '' && named.toLowerCase() !== 'here') target = { id: named, name: named }
        else if (active !== null && named === '' && app !== null) target = await learnedTarget(app, name, ctx, () => active.list(), deps)
        if (target !== null && active !== null && target.id !== deps.selfId()) {
          const outcome = await active.call(target.id, name, rest, ctx.chat ?? MAIN_CHAT, ctx)
          if (outcome.state !== 'done') return outcome.text
          return `On ${outcome.device} (its browser is where ${app?.name ?? 'the app'} is signed in): ${outcome.text}`
        }
        const out = await tool.run(rest, ctx)
        if (app !== null && learnedRanOk(out)) deps.learned.noteDevice(app.id, deps.selfId())
        return out
      },
    }
  })
}
