/** Anthropic Messages API. */
import { existsSync, readFileSync } from 'node:fs'

import { check } from '../http-policy'
import {
  asNumber,
  asObject,
  asString,
  type Block,
  type Completion,
  type ImageBlock,
  type JsonObject,
  type LlmProvider,
  type Msg,
  type Role,
  type ToolSpec,
} from '../model'
import { postJson } from './http'

export interface AnthropicOptions {
  apiKey: string
  baseUrl?: string
  allowHttp?: boolean
  fetchImpl?: typeof fetch
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic'
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly allowHttp: boolean
  private readonly fetchImpl: typeof fetch | undefined

  constructor(options: AnthropicOptions) {
    this.apiKey = options.apiKey
    this.baseUrl = options.baseUrl ?? 'https://api.anthropic.com/v1'
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
    const body: JsonObject = {
      model,
      max_tokens: maxTokens,
      system,
      messages: messages.map(toWire),
    }
    if (tools.length > 0) {
      body.tools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.schema,
      }))
    }
    check(this.baseUrl, this.allowHttp)
    const res = await postJson(
      `${trimSlash(this.baseUrl)}/messages`,
      {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
      { fetchImpl: this.fetchImpl },
    )
    const content = Array.isArray(res.content) ? res.content : []
    const blocks: Block[] = []
    for (const raw of content) {
      const b = asObject(raw)
      const kind = asString(b.type)
      if (kind === 'text') blocks.push({ t: 'text', text: asString(b.text) })
      else if (kind === 'tool_use') {
        blocks.push({
          t: 'call',
          id: asString(b.id),
          name: asString(b.name),
          input: asObject(b.input),
        })
      }
    }
    const usage = asObject(res.usage)
    return {
      message: { role: 'ASSISTANT', blocks },
      stopReason: asString(res.stop_reason),
      usage: {
        inputTokens: asNumber(usage.input_tokens),
        outputTokens: asNumber(usage.output_tokens),
      },
    }
  }
}

function toWire(m: Msg): JsonObject {
  const content: JsonObject[] = []
  for (const b of m.blocks) {
    switch (b.t) {
      case 'text':
        if (b.text.length > 0) content.push({ type: 'text', text: b.text })
        break
      case 'call':
        content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input })
        break
      case 'result':
        content.push({
          type: 'tool_result',
          tool_use_id: b.id,
          content: b.content,
          is_error: b.err,
        })
        break
      case 'image':
        if (existsSync(b.path)) content.push(imageWire(b))
        break
      case 'reasoning':
        break
    }
  }
  return { role: wireRole(m.role), content }
}

function imageWire(b: ImageBlock): JsonObject {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: b.mime,
      data: readFileSync(b.path).toString('base64'),
    },
  }
}

function wireRole(role: Role): string {
  return role === 'USER' ? 'user' : 'assistant'
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}
