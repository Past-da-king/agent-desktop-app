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
  ): Promise<Completion> {
    const wire: JsonObject[] = [{ role: 'system', content: system }]
    for (const m of messages) wire.push(...toWire(m, this.name))
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
    })
    const choices = Array.isArray(res.choices) ? res.choices : []
    const choice = asObject(choices[0])
    if (Object.keys(choice).length === 0) throw new ProviderException('No choices in response')
    const msg = asObject(choice.message)
    const blocks: Block[] = []
    const reasoning = asString(msg.reasoning_content)
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

function toWire(m: Msg, providerName: string): JsonObject[] {
  if (m.role === 'ASSISTANT') {
    const out: JsonObject = {
      role: 'assistant',
      content: msgText(m) || null,
    }
    // Reasoning models behind OpenAI-style APIs (DeepSeek, OpenCode) want their reasoning back on tool turns.
    const reasoning = m.blocks
      .filter((b): b is Extract<Block, { t: 'reasoning' }> => b.t === 'reasoning')
      .map((b) => b.text)
      .join('\n')
    if (reasoning) out.reasoning_content = reasoning
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
