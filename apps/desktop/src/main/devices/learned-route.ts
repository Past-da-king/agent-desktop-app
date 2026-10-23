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
 *  - else here.
 * When the choice fails because that browser is not signed in (or the tool only reads), the next device that could run
 * it is tried: where it last worked, then the person's computers. When none worked, the answer names every device
 * checked and what each said. A computer that dials in to a server counts as online there while it keeps talking to it
 * (devices/device-tools.ts HEARD_MS), so a helper on the server reaches it.
 * A run that worked here is recorded on the app, so the other devices know where it is signed in (the list travels in
 * the state bundle). A command that came from another device always runs here: it was already routed.
 */
import { MAIN_CHAT, type JsonObject, type Tool, type ToolContext } from '@agent/core'

import { hostOf, type LearnedApp, type LearnedStore } from '../apps/store'
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

/** A failure that reads as "this browser is not signed in to the site" (or the page never got there). */
const NOT_SIGNED_IN =
  /not (signed|logged) in|sign[- ]?in (page|required|first|needed)|log[- ]?in (page|required|first|needed)|please (sign|log) in|signed out|logged out|session (has )?expired|still loading|qr code|scan (the|a) qr|not authori[sz]ed|unauthori[sz]ed|\b401\b/i

/**
 * Whether a learned tool's failure here may be retried on another device: it says this browser is not signed in, or
 * the tool only reads (running it twice changes nothing). Never after the person declined, or for a wrong input.
 */
export function retryElsewhere(out: string, readOnly: boolean): boolean {
  if (learnedRanOk(out)) return false
  if (!out.startsWith('Error:')) return false
  return NOT_SIGNED_IN.test(out.slice(0, 1_000)) || readOnly
}

function short(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 160 ? `${one.slice(0, 157)}...` : one
}

/**
 * The other devices that could run it, best first: where it last worked (newest first), then the person's own
 * computers. Online ones only; `offline` lists the ones that offer it but are not reachable now.
 */
export function learnedCandidates(app: LearnedApp, tool: string, devices: ListedDevice[]): { able: ListedDevice[]; offline: ListedDevice[] } {
  const others = devices.filter((d) => !d.self && d.tools.includes(tool))
  const online = others.filter((d) => d.online)
  const known = [...(app.devices ?? [])].reverse()
  const ordered: ListedDevice[] = []
  for (const id of known) {
    const hit = online.find((d) => d.id === id)
    if (hit !== undefined && !ordered.includes(hit)) ordered.push(hit)
  }
  for (const d of online) if (personal(d.kind) && !ordered.includes(d)) ordered.push(d)
  return { able: ordered, offline: others.filter((d) => !d.online) }
}

/**
 * No device named: run it where it is signed in. The first choice (learnedTarget) runs; when that fails because
 * that browser is not signed in, the next device that could run it is tried, and so on. When none worked, the
 * answer names every device that was checked and what each said.
 */
async function autoRun(
  app: LearnedApp,
  tool: string,
  rest: JsonObject,
  ctx: ToolContext,
  hub: DeviceToolHub,
  deps: LearnedRouteDeps,
  runHere: (args: JsonObject) => Promise<string>,
): Promise<string> {
  const chat = ctx.chat ?? MAIN_CHAT
  const self = deps.selfId()
  let devices: ListedDevice[] = []
  try {
    devices = await hub.list()
  } catch {
    devices = []
  }
  const selfName = devices.find((d) => d.self)?.name ?? 'this device'
  const readOnly = app.tools.find((t) => t.name === str(rest['tool']))?.readOnly ?? false
  const first = await learnedTarget(app, tool, ctx, async () => devices, deps)
  const { able, offline } = learnedCandidates(app, tool, devices)
  const order: Array<{ id: string; name: string }> = []
  if (first !== null && first.id !== self) order.push(first)
  order.push({ id: self, name: selfName })
  for (const d of able) if (!order.some((o) => o.id === d.id)) order.push({ id: d.id, name: d.name })

  const checked: string[] = []
  for (const where of order) {
    if (where.id === self) {
      const out = await runHere(rest)
      if (learnedRanOk(out)) {
        deps.learned.noteDevice(app.id, self)
        return out
      }
      checked.push(`${where.name} (here): ${short(out)}`)
      if (!retryElsewhere(out, readOnly)) return out
      continue
    }
    const outcome = await hub.call(where.id, tool, rest, chat, ctx)
    if (outcome.state === 'waiting') return outcome.text
    const label = outcome.device === '' ? where.name : outcome.device
    if (outcome.state === 'done' && learnedRanOk(outcome.text)) {
      deps.learned.noteDevice(app.id, where.id)
      return `On ${label} (its browser is where ${app.name} is signed in): ${outcome.text}`
    }
    checked.push(`${label}: ${short(outcome.text)}`)
    // A device that refused or failed for another reason than its sign-in has said its answer.
    if (outcome.state === 'done' && !retryElsewhere(outcome.text, readOnly)) return `On ${label}: ${outcome.text}`
  }
  for (const d of offline) checked.push(`${d.name}: offline`)
  return `Error: ${app.name} is not signed in on any device that could run it (${hostOf(app.startUrl) || app.startUrl}). Checked: ${checked.join('; ')}. Sign in to it in one of these browsers (browser_handoff), then run it again.`
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
        const chat = ctx.chat ?? MAIN_CHAT
        // Named: exactly that device, no guessing.
        if (active !== null && named !== '' && named.toLowerCase() !== 'here' && named !== deps.selfId()) {
          const outcome = await active.call(named, name, rest, chat, ctx)
          if (outcome.state !== 'done') return outcome.text
          return `On ${outcome.device} (its browser is where ${app?.name ?? 'the app'} is signed in): ${outcome.text}`
        }
        const owner = ctx.owner ?? ''
        const routed = owner === 'device' || owner.startsWith('device:')
        // Without Devices, with "here", or for a command another device already routed: here, as asked.
        if (active === null || app === null || named !== '' || routed || deps.selfId() === '') {
          const out = await tool.run(rest, ctx)
          if (app !== null && learnedRanOk(out)) deps.learned.noteDevice(app.id, deps.selfId())
          return out
        }
        return autoRun(app, name, rest, ctx, active, deps, (args) => tool.run(args, ctx))
      },
    }
  })
}
