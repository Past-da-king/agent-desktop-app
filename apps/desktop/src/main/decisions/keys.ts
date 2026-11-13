/**
 * Which key each backend uses. Nothing new is asked of the person: Gemini uses the Gemini key the app already holds (the
 * Voice key, else a Gemini AI account); OpenAI and Jev use a matching AI account (OpenAI, or OpenRouter for Jev) or, for
 * a key kept only for decisions, the secret decisionsKey-<backend>. The key is read each call and never logged.
 */
import { keyNameFor, type Settings } from '@agent/core'

import type { DecisionKeys } from './service'

export interface SecretReader {
  get(name: string): string | null
}

function clean(value: string | null): string | null {
  return value === null || value.trim() === '' ? null : value.trim()
}

function accountKey(secrets: SecretReader, settings: Pick<Settings, 'accounts'>, provider: string): string | null {
  for (const account of settings.accounts ?? []) {
    if (account.kind === 'api' && account.provider === provider && account.hasKey) {
      const key = clean(secrets.get(keyNameFor(account.id)))
      if (key !== null) return key
    }
  }
  return null
}

export function resolveDecisionKeys(secrets: SecretReader, settings: () => Pick<Settings, 'accounts'>): DecisionKeys {
  return {
    gemini: () => clean(secrets.get('geminiKey')) ?? accountKey(secrets, settings(), 'gemini'),
    openai: () => clean(secrets.get('decisionsKey-openai')) ?? accountKey(secrets, settings(), 'openai'),
    jev: () => clean(secrets.get('decisionsKey-jev')) ?? accountKey(secrets, settings(), 'openrouter'),
  }
}
