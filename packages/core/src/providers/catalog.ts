/** The provider list, ported from reference/kotlin-shared/data/Settings.kt. Ids match `ProviderId` in ipc.ts. */
import type { ProviderId, ProviderInfo } from '../ipc'

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-sonnet-5-5',
    baseUrl: 'https://api.anthropic.com/v1',
    keyHint: 'sk-ant-...',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-5',
    baseUrl: 'https://api.openai.com/v1',
    keyHint: 'sk-...',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    defaultModel: 'gemini-flash-latest',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyHint: 'AIza...',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultModel: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com/v1',
    keyHint: 'sk-...',
  },
  {
    id: 'opencode_go',
    label: 'OpenCode Go',
    defaultModel: 'deepseek-v4.1-flash',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    keyHint: 'Paste your key here',
  },
  {
    id: 'opencode_zen',
    label: 'OpenCode Zen',
    defaultModel: 'claude-haiku-4-5',
    baseUrl: 'https://opencode.ai/zen/v1',
    keyHint: 'Paste your key here',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultModel: 'openrouter/auto',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyHint: 'sk-or-...',
  },
  {
    id: 'custom',
    label: 'Other (OpenAI-compatible)',
    defaultModel: '',
    baseUrl: '',
    keyHint: 'Paste your key here',
  },
]

export function providerInfo(id: ProviderId): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id)
}
