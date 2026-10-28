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

let labeller: (owner: string) => string = plainOwner

/** The app names its runs (a helper's label, a routine's name); until then owners read plainly. */
export function setOwnerLabeller(next: (owner: string) => string): void {
  labeller = next
}

/** Who a browser owner is, in plain words: "routine: Cosmiprint engagement", "helper: Fix the build", "main agent". */
export function ownerLabel(owner: string): string {
  try {
    return labeller(owner) || plainOwner(owner)
  } catch {
    return plainOwner(owner)
  }
}

export function plainOwner(owner: string): string {
  if (owner === 'main') return 'main agent'
  if (owner === 'routine') return 'routine'
  if (owner === 'voice') return 'call'
  if (owner.startsWith('chat:')) return `project chat ${owner.slice(5)}`
  if (owner.startsWith('helper:')) return `helper ${owner.slice(7)}`
  if (owner.startsWith('device:')) return `another device (${owner.slice(7)})`
  return owner
}
