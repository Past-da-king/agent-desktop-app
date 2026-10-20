/**
 * What a helper's profile allows, wrapped around the tools that act in the person's name, enforced in
 * code rather than asked of the model:
 * - the browser tools browse in the profile's own partition (its own cookies and sign-ins);
 * - learned apps run only when they are in the helper's profile (General has none), and a learned app a
 *   helper saves goes into its own profile, so it can run what it just taught itself.
 * Connected apps (apps_*) are held to the profile in AppGuard and apps.ts.
 *
 * The main agent and routines have no profile: they keep the original browser and may run everything.
 */
import type { AgentProfileInfo, Tool, ToolContext } from '@agent/core'

import { slugOf, type LearnedStore } from '../apps/store'

export interface ProfileGateDeps {
  /** The profile behind a call, or null for the main agent. */
  profileOf(ctx: ToolContext): AgentProfileInfo | null
  /** The partition a profile's helpers browse in. */
  partitionOf(profileId: string | null): string
  /** Switches the agent browser to a partition before a browser tool runs. Absent in tests without one. */
  usePartition?(partition: string): void
  learned?: LearnedStore
  /** Puts a learned app in a profile. */
  addLearned?(profileId: string, appId: string): void
}

const BROWSER_PREFIXES = ['browser_', 'webapp_']

export function usesBrowser(name: string): boolean {
  return BROWSER_PREFIXES.some((prefix) => name.startsWith(prefix)) && name !== 'webapp_guide' && name !== 'webapp_list'
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function gateTool(tool: Tool, deps: ProfileGateDeps): Tool {
  const name = tool.spec.name
  const browser = usesBrowser(name)
  const learnedRun = name === 'webapp_run' || name === 'webapp_test'
  const learnedSave = name === 'webapp_save'
  const learnedList = name === 'webapp_list'
  if (!browser && !learnedList) return tool
  return {
    spec: tool.spec,
    run: async (input, ctx) => {
      const profile = deps.profileOf(ctx)
      if (learnedRun && profile !== null) {
        const app = deps.learned?.find(str(input['app'])) ?? null
        if (app !== null && !profile.learned.includes(app.id)) {
          return `${app.name} is not in your profile (${profile.name}), so you cannot run it. Tell the main agent what you needed it for.`
        }
      }
      if (learnedList && profile !== null) {
        const out = await tool.run(input, ctx)
        const allowed = (deps.learned?.apps() ?? []).filter((a) => profile.learned.includes(a.id)).map((a) => a.name)
        return `Your profile (${profile.name}) may run only: ${allowed.length === 0 ? 'none of these' : allowed.join(', ')}.\n\n${out}`
      }
      if (browser) deps.usePartition?.(deps.partitionOf(profile?.id ?? null))
      const out = await tool.run(input, ctx)
      if (learnedSave && profile !== null && !profile.general && out.startsWith('Saved ')) {
        const id = slugOf(str(input['name']).trim())
        if (id !== '') deps.addLearned?.(profile.id, id)
      }
      return out
    },
  }
}
