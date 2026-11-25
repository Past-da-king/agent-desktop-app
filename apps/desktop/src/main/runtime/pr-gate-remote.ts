/**
 * PR grants travel only in the app's linked-device transport, never in a model tool argument.
 * Linked devices already authenticate that transport. The destination binds and consumes the
 * envelope against its command bytes and restores the real originating agent for audit.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { JsonObject, ToolContext } from '@agent/core'

export interface RemotePrGrant {
  id: string
  hash: string
  expires: number
  owner: string
  agentLabel: string
  chat: string
}
const outgoing = new WeakMap<ToolContext, RemotePrGrant>()
const incoming = new WeakMap<ToolContext, RemotePrGrant>()
const consumed = new Map<string, number>()
const TRANSPORT_KEY = '_agentPrGateGrant'
const CALLER_KEY = '_agentPrGateCaller'
const localHolds = new WeakSet<ToolContext>()
const remoteHolds = new WeakSet<ToolContext>()
export function markDestinationHold(ctx: ToolContext): void {
  localHolds.add(ctx)
}
export function takeDestinationHold(ctx: ToolContext): boolean {
  const held = localHolds.has(ctx)
  localHolds.delete(ctx)
  return held
}
export function recordRemoteResult(ctx: ToolContext, value: unknown): void {
  if (
    value &&
    typeof value === 'object' &&
    (value as Record<string, unknown>)['prGateHeld'] === true
  )
    remoteHolds.add(ctx)
}
export function takeRemoteChallenge(ctx: ToolContext): boolean {
  const held = remoteHolds.has(ctx)
  remoteHolds.delete(ctx)
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
    .update(JSON.stringify(ordered({ tool, args: cleanArguments(args) })))
    .digest('hex')
}
export function prepareRemoteGrant(
  ctx: ToolContext,
  tool: string,
  args: JsonObject,
): void {
  outgoing.set(ctx, {
    id: randomUUID(),
    hash: digest(tool, args),
    expires: Date.now() + 60_000,
    owner: ctx.owner ?? ctx.agentLabel,
    agentLabel: ctx.agentLabel,
    chat: ctx.chat ?? 'main',
  })
}
/** Called by DeviceToolHub, which always discards model-supplied transport fields. */
export function remoteArguments(
  ctx: ToolContext | undefined,
  tool: string,
  args: JsonObject,
): JsonObject {
  const clean = cleanArguments(args)
  const grant = ctx ? outgoing.get(ctx) : undefined
  if (ctx) outgoing.delete(ctx)
  const caller = ctx
    ? {
        owner: ctx.owner ?? ctx.agentLabel,
        agentLabel: ctx.agentLabel,
        chat: ctx.chat ?? 'main',
      }
    : undefined
  return {
    ...clean,
    ...(caller ? { [CALLER_KEY]: caller } : {}),
    ...(grant && grant.hash === digest(tool, clean)
      ? { [TRANSPORT_KEY]: grant as unknown as JsonObject }
      : {}),
  }
}
/** Only DeviceToolHost invokes this, after the linked transport has authenticated its peer. */
export function receiveRemoteGrant(
  ctx: ToolContext,
  tool: string,
  args: JsonObject,
): { context: ToolContext; args: JsonObject } {
  const clean = cleanArguments(args),
    raw = args[TRANSPORT_KEY],
    caller = args[CALLER_KEY]
  let context = ctx
  if (caller && typeof caller === 'object' && !Array.isArray(caller)) {
    const who = caller as Record<string, unknown>
    if (
      typeof who['owner'] === 'string' &&
      typeof who['agentLabel'] === 'string' &&
      typeof who['chat'] === 'string'
    )
      context = {
        ...ctx,
        owner: who['owner'],
        agentLabel: who['agentLabel'],
        chat: who['chat'],
      }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { context, args: clean }
  const grant = raw as unknown as RemotePrGrant
  if (
    typeof grant.id !== 'string' ||
    grant.owner !== context.owner ||
    grant.agentLabel !== context.agentLabel ||
    grant.chat !== context.chat ||
    !Number.isFinite(grant.expires) ||
    grant.expires < Date.now() ||
    grant.expires > Date.now() + 60_000 ||
    grant.hash !== digest(tool, clean)
  )
    return { context, args: clean }
  incoming.set(context, grant)
  return { context, args: clean }
}

export function consumeRemoteGrant(
  ctx: ToolContext,
  tool: string,
  args: JsonObject,
): boolean {
  const grant = incoming.get(ctx)
  if (!grant || grant.hash !== digest(tool, args) || grant.expires < Date.now())
    return false
  incoming.delete(ctx)
  for (const [id, expiry] of consumed)
    if (expiry < Date.now()) consumed.delete(id)
  if (consumed.has(grant.id)) return false
  consumed.set(grant.id, grant.expires)
  return true
}
