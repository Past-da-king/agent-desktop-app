/**
 * App-only linked-device gate state. Enumerable symbols survive the production
 * origin/vault context copies without changing destination ownership.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { JsonObject, ToolContext } from '@agent/core'
import { canonTool } from '../devices/device-tools'

interface Caller {
  owner: string
  agentLabel: string
  chat: string
}
export interface RemotePrGrant extends Caller {
  id: string
  hash: string
  expires: number
}
interface CallState {
  fromHost?: boolean
  incoming?: RemotePrGrant
  outgoing?: RemotePrGrant
  caller?: Caller
  localHold?: boolean
  remoteHold?: boolean
}
const STATE = Symbol('pr-gate-call')
type GateContext = ToolContext & { [STATE]?: CallState }
function state(ctx: ToolContext): CallState {
  const target = ctx as GateContext
  return target[STATE] ?? (target[STATE] = {})
}
export function beginPrGateCall(ctx: ToolContext): ToolContext {
  const copy = { ...ctx } as GateContext
  if (!copy[STATE]?.fromHost) copy[STATE] = {}
  else delete copy[STATE]!.fromHost
  return copy
}
export function remoteCaller(ctx: ToolContext): Caller {
  return (
    (ctx as GateContext)[STATE]?.caller ?? {
      owner: ctx.owner ?? ctx.agentLabel,
      agentLabel: ctx.agentLabel,
      chat: ctx.chat ?? 'main',
    }
  )
}
const consumed = new Map<string, number>()
const TRANSPORT_KEY = '_agentPrGateGrant'
const CALLER_KEY = '_agentPrGateCaller'
const TRANSIT_MS = 20 * 60_000
const SKEW_MS = 120_000
export function markDestinationHold(ctx: ToolContext): void {
  state(ctx).localHold = true
}
export function takeDestinationHold(ctx: ToolContext): boolean {
  const held = state(ctx).localHold === true
  delete state(ctx).localHold
  return held
}
export function recordRemoteResult(ctx: ToolContext, value: unknown): void {
  if (
    value &&
    typeof value === 'object' &&
    (value as Record<string, unknown>)['prGateHeld'] === true
  )
    state(ctx).remoteHold = true
}
export function takeRemoteChallenge(ctx: ToolContext): boolean {
  const held = state(ctx).remoteHold === true
  delete state(ctx).remoteHold
  return held
}
function cleanArguments(args: JsonObject): JsonObject {
  const clean = { ...args }
  delete clean[TRANSPORT_KEY]
  delete clean[CALLER_KEY]
  return clean
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, ordered(item)]),
    )
  return value
}
function digest(tool: string, args: JsonObject): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        ordered({ tool: canonTool(tool), args: cleanArguments(args) }),
      ),
    )
    .digest('hex')
}
export function prepareRemoteGrant(
  ctx: ToolContext,
  tool: string,
  args: JsonObject,
): void {
  state(ctx).outgoing = {
    id: randomUUID(),
    hash: digest(tool, args),
    expires: Date.now() + TRANSIT_MS,
    ...remoteCaller(ctx),
  }
}
export function remoteArguments(
  ctx: ToolContext | undefined,
  tool: string,
  args: JsonObject,
): JsonObject {
  const clean = cleanArguments(args),
    grant = ctx ? state(ctx).outgoing : undefined
  if (ctx) delete state(ctx).outgoing
  // No caller envelope for ordinary remote calls, including gate-off browser calls.
  return {
    ...clean,
    ...(grant && grant.hash === digest(tool, clean)
      ? { [TRANSPORT_KEY]: grant as unknown as JsonObject }
      : {}),
  }
}
export function receiveRemoteGrant(
  ctx: ToolContext,
  tool: string,
  args: JsonObject,
): { context: ToolContext; args: JsonObject } {
  // Establish the capsule BEFORE withOrigin and the vault guard copy the context.
  ;(ctx as GateContext)[STATE] = { fromHost: true }
  const clean = cleanArguments(args),
    raw = args[TRANSPORT_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { context: ctx, args: clean }
  const grant = raw as unknown as RemotePrGrant,
    now = Date.now()
  if (
    typeof grant.id !== 'string' ||
    !grant.id ||
    typeof grant.owner !== 'string' ||
    typeof grant.agentLabel !== 'string' ||
    typeof grant.chat !== 'string' ||
    !Number.isFinite(grant.expires) ||
    grant.expires < now - SKEW_MS ||
    grant.expires > now + TRANSIT_MS + SKEW_MS ||
    grant.hash !== digest(tool, clean)
  )
    return { context: ctx, args: clean }
  state(ctx).caller = {
    owner: grant.owner,
    agentLabel: grant.agentLabel,
    chat: grant.chat,
  }
  // Execution freshness uses the destination clock, independent of origin skew.
  state(ctx).incoming = { ...grant, expires: now + 60_000 }
  return { context: ctx, args: clean }
}
export function consumeRemoteGrant(
  ctx: ToolContext,
  tool: string,
  args: JsonObject,
): boolean {
  const grant = state(ctx).incoming
  if (!grant || grant.hash !== digest(tool, args) || grant.expires < Date.now())
    return false
  delete state(ctx).incoming
  for (const [id, expiry] of consumed)
    if (expiry < Date.now()) consumed.delete(id)
  if (consumed.has(grant.id)) return false
  consumed.set(grant.id, Date.now() + TRANSIT_MS + SKEW_MS)
  return true
}
