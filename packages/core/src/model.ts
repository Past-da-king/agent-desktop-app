/**
 * Provider-neutral conversation model. Every provider adapter converts to and from this,
 * so the loop, the tools and the stored transcript never know which AI is behind them.
 *
 * The JSON shape is byte-compatible with the Kotlin `Msg.toJson` in
 * reference/kotlin-shared/agent/Model.kt, because turn rows may later be shared with the phone.
 */
import { existsSync } from 'node:fs'

export type Role = 'USER' | 'ASSISTANT'

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export interface TextBlock {
  t: 'text'
  text: string
}

export interface ToolCallBlock {
  t: 'call'
  id: string
  name: string
  input: JsonObject
  /** Provider data that must travel back with the call untouched (Gemini's thought_signature). */
  extra?: JsonObject
}

export interface ToolResultBlock {
  t: 'result'
  id: string
  content: string
  err: boolean
}

export interface ReasoningBlock {
  t: 'reasoning'
  text: string
}

export interface ImageBlock {
  t: 'image'
  path: string
  mime: string
}

export type Block = TextBlock | ToolCallBlock | ToolResultBlock | ReasoningBlock | ImageBlock

export interface Msg {
  role: Role
  blocks: Block[]
}

/** Everything the model said in plain text, joined the same way Kotlin joins it. */
export function msgText(m: Msg): string {
  return m.blocks
    .filter((b): b is TextBlock => b.t === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

export function msgToolCalls(m: Msg): ToolCallBlock[] {
  return m.blocks.filter((b): b is ToolCallBlock => b.t === 'call')
}

export function userMsg(text: string, images: string[] = []): Msg {
  const blocks: Block[] = images
    .filter((path) => existsSync(path))
    .map((path) => ({ t: 'image', path, mime: 'image/jpeg' }))
  blocks.push({ t: 'text', text })
  return { role: 'USER', blocks }
}

export function msgToJson(m: Msg): JsonObject {
  return { role: m.role, blocks: m.blocks.map(blockToJson) }
}

export function msgFromJson(value: unknown): Msg {
  const o = asObject(value)
  const roleValue = o.role
  if (roleValue !== 'USER' && roleValue !== 'ASSISTANT') {
    throw new Error(`Unknown role: ${String(roleValue)}`)
  }
  const rawBlocks = Array.isArray(o.blocks) ? o.blocks : []
  return { role: roleValue, blocks: rawBlocks.map(blockFromJson) }
}

function blockToJson(b: Block): JsonValue {
  switch (b.t) {
    case 'text':
      return { t: 'text', text: b.text }
    case 'call': {
      const out: JsonObject = { t: 'call', id: b.id, name: b.name, input: b.input }
      if (b.extra !== undefined) out.extra = b.extra
      return out
    }
    case 'result':
      return { t: 'result', id: b.id, content: b.content, err: b.err }
    case 'image':
      return { t: 'image', path: b.path, mime: b.mime }
    case 'reasoning':
      return { t: 'reasoning', text: b.text }
  }
}

function blockFromJson(value: JsonValue): Block {
  const b = asObject(value)
  const kind = asString(b.t)
  switch (kind) {
    case 'call': {
      const call: ToolCallBlock = {
        t: 'call',
        id: asString(b.id),
        name: asString(b.name),
        input: asObject(b.input),
      }
      if (isObject(b.extra)) call.extra = b.extra
      return call
    }
    case 'result':
      return { t: 'result', id: asString(b.id), content: asString(b.content), err: b.err === true }
    case 'image':
      return { t: 'image', path: asString(b.path), mime: asString(b.mime) || 'image/jpeg' }
    case 'reasoning':
      return { t: 'reasoning', text: asString(b.text) }
    default:
      return { t: 'text', text: asString(b.text) }
  }
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {}
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** What a tool looks like to the model. `schema` is a JSON Schema object. */
export interface ToolSpec {
  name: string
  description: string
  schema: JsonObject
}

/** Something the agent can do. Expected failures come back as a plain-words result, not a throw. */
export interface Tool {
  spec: ToolSpec
  run(input: JsonObject, ctx: ToolContext): Promise<string>
}

/** What a running tool can reach: the person, and who it is running for. */
export interface ToolContext {
  /** "main" for the user-facing agent; a helper's label otherwise. */
  agentLabel: string
  /** A stable id for who is acting ("main", "routine", "helper:<id>"): each one gets its own browser tab. */
  owner?: string
  /** The id of the profile a helper works in (its accounts and browser sign-ins). Absent for the main agent. */
  profile?: string
  /** The chat this run belongs to (MAIN_CHAT when absent), so a helper it starts reports back to the same chat. */
  chat?: string
  /** Show a short line of activity in the chat ("Searched memory"). Returns an id to update. */
  activity(text: string, meta?: JsonObject): Promise<number>
  updateActivity(id: number, text: string, meta?: JsonObject): Promise<void>
  /** Ask the person and wait for the answer. Null when nobody can answer (a background run). */
  ask(question: string, options: string[], card?: JsonObject): Promise<string | null>
  /** Ask permission before something that changes the outside world. */
  /**
   * Ask the person to approve. `scope: 'computer'` marks an action that stays on this computer (a command, code,
   * a file): its card can also offer "Always allow on this computer". Anything sent or done elsewhere has no scope.
   */
  approve(summary: string, details?: string, scope?: 'computer'): Promise<boolean>
  notify(title: string, body: string): Promise<void>
  signal: AbortSignal
  /**
   * Commands and files for this run, when it is not this computer's own setting: a helper another computer placed
   * here works with the choice the person made on that computer. Absent: this computer's Settings.
   */
  shell?: 'always' | 'ask' | 'never'
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export interface Completion {
  message: Msg
  stopReason: string
  usage: Usage
}

export class ProviderException extends Error {
  constructor(
    message: string,
    readonly status: number = 0,
    readonly retryable: boolean = false,
  ) {
    super(message)
    this.name = 'ProviderException'
  }
}

export interface LlmProvider {
  readonly name: string
  complete(
    system: string,
    messages: Msg[],
    tools: ToolSpec[],
    model: string,
    maxTokens?: number,
  ): Promise<Completion>
}

/** Tiny builder so tool schemas read like documentation. */
export function schema(required: string[], props: Record<string, JsonObject>): JsonObject {
  return {
    type: 'object',
    properties: props,
    required,
  }
}

export function str(description: string): JsonObject {
  return { type: 'string', description }
}

export function int(description: string): JsonObject {
  return { type: 'integer', description }
}

export function bool(description: string): JsonObject {
  return { type: 'boolean', description }
}

export function enumOf(description: string, ...values: string[]): JsonObject {
  return { type: 'string', description, enum: values }
}

export function strList(description: string): JsonObject {
  return { type: 'array', description, items: { type: 'string' } }
}
