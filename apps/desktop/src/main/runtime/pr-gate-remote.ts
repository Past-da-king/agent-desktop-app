/**
 * App-only linked-device gate state. Enumerable symbols survive the production
 * origin/vault context copies without changing destination ownership.
 */
import { createHash, randomUUID, sign, verify } from 'node:crypto'
import type { JsonObject, ToolContext } from '@agent/core'
import { canonTool } from '../devices/device-tools'
import { prGateKey, privateKey, publicKey, keyId } from './pr-gate-key'

interface Caller {
  owner: string
  agentLabel: string
  chat: string
}
export interface RemotePrGrant extends Caller {
  id: string
  hash: string
  expires: number
  signer?: string
  signature?: string
}
interface CallState {
  fromHost?: boolean
  freshUntil?: number
  incoming?: RemotePrGrant
  outgoing?: RemotePrGrant
  retry?: () => RemotePrGrant
  alreadyRan?: boolean
  notSignedIn?: boolean
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
function body(grant: RemotePrGrant): Buffer {
  const { signature: _signature, ...value } = grant
  void _signature
  return Buffer.from(JSON.stringify(ordered(value)))
}
function signature(grant: RemotePrGrant, key: string): string {
  return sign(null, body(grant), privateKey(key)).toString('hex')
}
function signed(grant: RemotePrGrant, key: string): boolean {
  if (
    typeof grant.signature !== 'string' ||
    !/^[a-f0-9]{128}$/.test(grant.signature)
  )
    return false
  try {
    const pub = key.includes('PUBLIC KEY') ? key : publicKey(key)
    return (
      grant.signer === keyId(pub) &&
      verify(null, body(grant), pub, Buffer.from(grant.signature, 'hex'))
    )
  } catch {
    return false
  }
}
export function markAlreadyRan(ctx: ToolContext): void {
  state(ctx).alreadyRan = true
}
export function takeAlreadyRan(ctx: ToolContext): boolean {
  const ran = state(ctx).alreadyRan === true
  delete state(ctx).alreadyRan
  return ran
}
export function incomingSigner(ctx: ToolContext): string | undefined {
  return state(ctx).incoming?.signer
}
// Only the app routing loop calls this after a definite sign-in refusal.
export function retryRemoteGrant(ctx: ToolContext): void {
  const call = state(ctx)
  if (call.retry) call.outgoing = call.retry()
}
export function incomingGrantId(ctx: ToolContext): string | undefined {
  return state(ctx).incoming?.id
}
export function prepareRemoteGrant(
  ctx: ToolContext,
  tool: string,
  args: JsonObject,
  key = prGateKey(),
): void {
  const mint = (): RemotePrGrant => {
    const grant: RemotePrGrant = {
      signer: keyId(publicKey(key)),
      id: randomUUID(),
      hash: digest(tool, args),
      expires: Date.now() + TRANSIT_MS,
      ...remoteCaller(ctx),
    }
    grant.signature = signature(grant, key)
    return grant
  }
  state(ctx).retry = mint
  state(ctx).outgoing = mint()
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
    grant.hash !== digest(tool, clean)
  )
    return { context: ctx, args: clean }
  // The destination verifies with the originating brain public key before trusting caller identity.
  state(ctx).incoming = grant
  state(ctx).freshUntil = now + 60_000
  return { context: ctx, args: clean }
}
export function verifiedRemoteGrant(
  ctx: ToolContext,
  tool: string,
  args: JsonObject,
  key: string,
): boolean {
  const grant = state(ctx).incoming
  return !!grant && grant.hash === digest(tool, args) && signed(grant, key)
}
export function remoteGrantConsumed(ctx: ToolContext): boolean {
  const id = state(ctx).incoming?.id
  return !!id && consumed.has(id)
}
export function markNotSignedIn(ctx: ToolContext): void {
  state(ctx).notSignedIn = true
}
export function takeNotSignedIn(ctx: ToolContext): boolean {
  const value = !!state(ctx).notSignedIn
  delete state(ctx).notSignedIn
  return value
}
export function consumeRemoteGrant(
  ctx: ToolContext,
  tool: string,
  args: JsonObject,
  key = prGateKey(),
): boolean {
  const grant = state(ctx).incoming
  if (
    !grant ||
    grant.expires < Date.now() - SKEW_MS ||
    grant.expires > Date.now() + TRANSIT_MS + SKEW_MS ||
    grant.hash !== digest(tool, args) ||
    (state(ctx).freshUntil ?? 0) < Date.now() ||
    !signed(grant, key)
  )
    return false
  delete state(ctx).incoming
  for (const [id, expiry] of consumed)
    if (expiry < Date.now()) consumed.delete(id)
  if (consumed.has(grant.id)) return false
  consumed.set(grant.id, Date.now() + TRANSIT_MS + SKEW_MS)
  state(ctx).caller = {
    owner: grant.owner,
    agentLabel: grant.agentLabel,
    chat: grant.chat,
  }
  return true
}

/** Only verified gated calls need the pre-execution sign-in fence. */
export function remoteGateExecution(ctx: ToolContext): boolean {
  return Boolean(state(ctx)?.caller)
}
