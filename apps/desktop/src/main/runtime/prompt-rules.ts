/**
 * The person's standing instructions, read fresh from the store for every run (shared/prompt-rules.ts). Every place
 * that builds a system prompt calls this at the start of the run, so a rule added a moment ago is in the very next
 * one, on this computer and on every device the rows sync to. Never cached.
 */
import type { PromptRuleRow } from '@agent/core'

import type { DataStore } from './data'

export async function promptRulesFor(store: Pick<DataStore, 'list'>): Promise<PromptRuleRow[]> {
  try {
    return await store.list('prompt_rule')
  } catch {
    // A store that cannot read them (an older test fake) gives a prompt without them, never no prompt.
    return []
  }
}
