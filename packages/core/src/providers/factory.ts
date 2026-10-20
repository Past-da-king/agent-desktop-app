/** Builds the provider adapter for a chosen provider/key, mirroring ProviderFactory.kt. */
import { randomUUID } from 'node:crypto'

import type { ProviderId } from '../ipc'
import { ProviderException, type JsonObject, type LlmProvider } from '../model'
import { AnthropicProvider } from './anthropic'
import { providerInfo } from './catalog'
import { OpenAiCompatProvider } from './openai-compat'

export interface ProviderForOptions {
  provider: ProviderId
  key: string
  baseUrl?: string
  allowHttp?: boolean
  sessionId?: string
  fetchImpl?: typeof fetch
}

export function providerFor(options: ProviderForOptions): LlmProvider {
  const info = providerInfo(options.provider)
  if (!info) throw new ProviderException(`Unknown provider: ${options.provider}`)
  const baseUrl = options.baseUrl?.trim() || info.baseUrl
  const allowHttp = options.allowHttp ?? false
  const fetchImpl = options.fetchImpl

  if (options.provider === 'anthropic') {
    return new AnthropicProvider({ apiKey: options.key, baseUrl, allowHttp, fetchImpl })
  }

  const extra: JsonObject | undefined =
    options.provider === 'deepseek' ? { thinking: { type: 'disabled' } } : undefined
  const extraHeaders =
    options.provider === 'opencode_go' || options.provider === 'opencode_zen'
      ? () => ({ 'x-opencode-session': options.sessionId ?? `desktop-${randomUUID()}` })
      : undefined

  return new OpenAiCompatProvider({
    name: options.provider,
    apiKey: options.key,
    baseUrl,
    extra,
    extraHeaders,
    allowHttp,
    fetchImpl,
  })
}
