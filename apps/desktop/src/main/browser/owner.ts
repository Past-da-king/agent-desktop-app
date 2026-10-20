/**
 * Who is driving the agent's browser right now. Each agent (the main one, a routine, every helper) gets
 * its own tab, so two helpers browsing at once never land on each other's page. The owner is carried
 * through every await of a tool call by AsyncLocalStorage, so interleaved calls cannot mix up their tabs.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export const browserOwner = new AsyncLocalStorage<{ owner: string }>()

export function currentOwner(): string | undefined {
  return browserOwner.getStore()?.owner
}
