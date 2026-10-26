/**
 * OpenAI Chat Completions shape: OpenAI, OpenRouter, DeepSeek, OpenCode and Gemini's
 * OpenAI-compatible endpoint.
 */
import { existsSync, readFileSync } from 'node:fs'

import { check } from '../http-policy'
import {
  ProviderException,
  asNumber,
  asObject,
  asString,
  msgText,
  msgToolCalls,
  type Block,
  type Completion,
  type ImageBlock,
  type JsonObject,
  type LlmProvider,
  type Msg,
  type ToolCallBlock,
  type ToolSpec,
} from '../model'
import { postJson } from './http'

export interface OpenAiCompatOptions {
  name: string
  apiKey: string
  baseUrl: string
  /** Provider-specific body fields, e.g. DeepSeek's thinking switch. */
  extra?: JsonObject
  /** Provider-specific headers, e.g. OpenCode's per-conversation session id. */
  extraHeaders?: () => Record<string, string>
  /** The user opted in to plain http:// for this server (self-hosted on their LAN). */
  allowHttp?: boolean
  fetchImpl?: typeof fetch
}

export class OpenAiCompatProvider implements LlmProvider {
  readonly name: string
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly extra: JsonObject | undefined
  private readonly extraHeaders: (() => Record<string, string>) | undefined
  private readonly allowHttp: boolean
  private readonly fetchImpl: typeof fetch | undefined

  constructor(options: OpenAiCompatOptions) {
    this.name = options.name
    this.apiKey = options.apiKey
    this.baseUrl = options.baseUrl
    this.extra = options.extra
    this.extraHeaders = options.extraHeaders
    this.allowHttp = options.allowHttp ?? false
    this.fetchImpl = options.fetchImpl
  }

  async complete(
    system: string,
    messages: Msg[],
    tools: ToolSpec[],
    model: string,
    maxTokens = 4096,
    signal?: AbortSignal,
  ): Promise<Completion> {
    const wire: JsonObject[] = [{ role: 'system', content: system }]
    const echoReasoning = wantsReasoningBack(this.name, messages)
    for (const m of messages) wire.push(...toWire(m, this.name, echoReasoning))
    const body: JsonObject = { model, messages: wire, max_tokens: maxTokens }
    if (this.extra) {
      for (const [key, value] of Object.entries(this.extra)) body[key] = value
    }
    if (tools.length > 0) {
      body.tools = tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.schema,
        },
      }))
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      ...(this.extraHeaders?.() ?? {}),
    }
    if (this.name === 'openrouter') headers['X-Title'] = 'Agent desktop'
    check(this.baseUrl, this.allowHttp)
    const res = await postJson(`${trimSlash(this.baseUrl)}/chat/completions`, headers, body, {
      fetchImpl: this.fetchImpl,
      ...(signal === undefined ? {} : { signal }),
    })
    const choices = Array.isArray(res.choices) ? res.choices : []
    const choice = asObject(choices[0])
    if (Object.keys(choice).length === 0) throw new ProviderException('No choices in response')
    const msg = asObject(choice.message)
    const blocks: Block[] = []
    // DeepSeek and OpenCode say reasoning_content; OpenRouter and some gateways say reasoning.
    const reasoning = asString(msg.reasoning_content) || asString(msg.reasoning)
    if (reasoning && reasoning !== 'null') blocks.push({ t: 'reasoning', text: reasoning })
    const content = asString(msg.content)
    if (content && content !== 'null') blocks.push({ t: 'text', text: content })
    if (Array.isArray(msg.tool_calls)) {
      msg.tool_calls.forEach((raw, index) => {
        const c = asObject(raw)
        const f = asObject(c.function)
        const args = asObject(parseJson(asString(f.arguments) || '{}'))
        const call: ToolCallBlock = {
          t: 'call',
          id: asString(c.id) || `call_${index}`,
          name: asString(f.name),
          input: args,
        }
        if (isPlainObject(c.extra_content)) call.extra = c.extra_content
        blocks.push(call)
      })
    }
    const usage = asObject(res.usage)
    return {
      message: { role: 'ASSISTANT', blocks },
      stopReason: asString(choice.finish_reason),
      usage: {
        inputTokens: asNumber(usage.prompt_tokens),
        outputTokens: asNumber(usage.completion_tokens),
      },
    }
  }
}

/**
 * Providers that can serve a thinking model behind the OpenAI shape. DeepSeek's thinking mode
 * (also what OpenCode Go/Zen proxy to) answers 400 "The reasoning_content in the thinking mode must
 * be passed back to the API" when ANY earlier assistant message in a request with tools lacks it:
 * turns where the model thought nothing, turns with no tool call, and turns written by another
 * model before a switch or fallback.
 */
const THINKING_PROVIDERS = new Set(['deepseek', 'opencode_go', 'opencode_zen'])

/** Stand-in for a turn with no reasoning of its own. An empty string reads as missing upstream. */
export const REASONING_PLACEHOLDER = ' '

/** Whether every assistant turn should carry reasoning_content on the wire. */
export function wantsReasoningBack(providerName: string, messages: Msg[]): boolean {
  if (THINKING_PROVIDERS.has(providerName)) return true
  // Any other server that handed us reasoning (custom, OpenRouter...) is serving a thinking model too.
  return messages.some((m) => m.role === 'ASSISTANT' && m.blocks.some((b) => b.t === 'reasoning'))
}

function toWire(m: Msg, providerName: string, echoReasoning = false): JsonObject[] {
  if (m.role === 'ASSISTANT') {
    const out: JsonObject = {
      role: 'assistant',
      content: msgText(m) || null,
    }
    // Reasoning models behind OpenAI-style APIs (DeepSeek, OpenCode) want their reasoning back on
    // every assistant turn, not only the ones that thought out loud.
    const reasoning = m.blocks
      .filter((b): b is Extract<Block, { t: 'reasoning' }> => b.t === 'reasoning')
      .map((b) => b.text)
      .join('\n')
    if (reasoning.trim()) out.reasoning_content = reasoning
    else if (echoReasoning) out.reasoning_content = REASONING_PLACEHOLDER
    const calls = msgToolCalls(m)
    if (calls.length > 0) {
      out.tool_calls = calls.map((call) => {
        const wire: JsonObject = {
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        }
        // Gemini 3 rejects a tool call sent back without its thought_signature. Echo the real one;
        // for calls saved before we kept it (or made by another model), Google's documented
        // placeholder tells it to skip the check instead of failing the whole conversation.
        const extra =
          call.extra ??
          (providerName === 'gemini'
            ? { google: { thought_signature: 'skip_thought_signature_validator' } }
            : undefined)
        if (extra !== undefined) wire.extra_content = extra
        return wire
      })
    }
    return [out]
  }

  const out: JsonObject[] = []
  for (const b of m.blocks) {
    if (b.t === 'result') {
      out.push({ role: 'tool', tool_call_id: b.id, content: b.content })
    }
  }
  const text = msgText(m)
  const images = m.blocks
    .filter((b): b is ImageBlock => b.t === 'image')
    .filter((b) => existsSync(b.path))
  if (images.length > 0) {
    const content: JsonObject[] = images.map((image) => ({
      type: 'image_url',
      image_url: { url: `data:${image.mime};base64,${readFileSync(image.path).toString('base64')}` },
    }))
    if (text) content.push({ type: 'text', text })
    out.push({ role: 'user', content })
  } else if (text) {
    out.push({ role: 'user', content: text })
  }
  return out
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}
