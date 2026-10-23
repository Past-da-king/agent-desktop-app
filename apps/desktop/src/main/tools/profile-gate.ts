/**
 * What a helper's profile allows, wrapped around the tools that act in the person's name, enforced in
 * code rather than asked of the model:
 * - the browser tools browse in the profile's own partition (its own cookies and sign-ins);
 * - learned apps follow the browser sign-in (decided 23 Oct 2026): a learned app runs for any agent that
 *   browses in a partition where its site is signed in, plus the learned apps its profile lists. A
 *   learned app a helper saves goes into its own profile too, so it can run what it just taught itself.
 * Connected apps (apps_*) are held to the profile in AppGuard and apps.ts.
 *
 * "Signed in in this partition" is read from real data: the partitions the app was saved or run in
 * (LearnedApp.partitions), and the site data the partition's session holds for the app's address.
 *
 * The main agent has no profile: it keeps the original browser and may run everything.
 */
import type { AgentProfileInfo, Tool, ToolContext } from '@agent/core'

import { BASE_PARTITION } from '../apps/profiles'
import { hostOf, slugOf, type LearnedApp, type LearnedStore } from '../apps/store'

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
  /** Every profile, to name the browsers an app is signed in to in a refusal. */
  profiles?(): AgentProfileInfo[]
  /** Whether a partition's browser holds site data (cookies, storage) for an address. Absent: unknown. */
  siteSignedIn?(partition: string, url: string): Promise<boolean>
}

const BROWSER_PREFIXES = ['browser_', 'webapp_']

export function usesBrowser(name: string): boolean {
  return BROWSER_PREFIXES.some((prefix) => name.startsWith(prefix)) && name !== 'webapp_guide' && name !== 'webapp_list'
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * The partitions an app is known to be signed in to. An app saved before this was recorded counts as
 * signed in where it was most likely taught: the original browser (the main agent's), and the browsers
 * of the profiles that list it.
 */
export function partitionsOfApp(app: LearnedApp, deps: Pick<ProfileGateDeps, 'partitionOf' | 'profiles'>): string[] {
  if (app.partitions !== undefined && app.partitions.length > 0) return [...app.partitions]
  const listed = (deps.profiles?.() ?? []).filter((p) => p.learned.includes(app.id)).map((p) => deps.partitionOf(p.id))
  return [...new Set([BASE_PARTITION, ...listed])]
}

/** The browser names a partition belongs to: "General", "Work", or "Work and Client" when shared. */
function browserNames(partition: string, deps: Pick<ProfileGateDeps, 'partitionOf' | 'profiles'>): string {
  const names = (deps.profiles?.() ?? []).filter((p) => deps.partitionOf(p.id) === partition).map((p) => p.name)
  if (names.length === 0) return partition === BASE_PARTITION ? 'General' : partition
  return names.join(' and ')
}

export type LearnedAccess = { ok: true } | { ok: false; message: string }

/** May this agent run this learned app? The main agent always may. */
export async function learnedAccess(app: LearnedApp, profile: AgentProfileInfo | null, deps: ProfileGateDeps): Promise<LearnedAccess> {
  if (profile === null) return { ok: true }
  if (profile.learned.includes(app.id)) return { ok: true }
  const mine = deps.partitionOf(profile.id)
  const known = partitionsOfApp(app, deps)
  if (known.includes(mine)) return { ok: true }
  if (deps.siteSignedIn !== undefined) {
    try {
      if (await deps.siteSignedIn(mine, app.startUrl)) return { ok: true }
    } catch {
      // Reading the session failed: treat it as not signed in, the refusal says how to fix it.
    }
  }
  const host = hostOf(app.startUrl) || app.startUrl
  const where = [...new Set(known.map((p) => browserNames(p, deps)))].join(', ')
  const own = profile.general ? 'the General browser (shared with the main agent)' : `profile ${profile.name}'s browser`
  const fix = profile.general
    ? `Sign in to ${host} in the General browser (the main agent can browser_open it and hand it to the person), or delegate the job to a profile whose browser is signed in to it (${where}).`
    : `Add ${app.name} to profile ${profile.name} (Connections > Learned apps > ${app.name}, tick ${profile.name}; or Edit profile ${profile.name} > Learned apps), or sign in to ${host} in that profile's browser.`
  return {
    ok: false,
    message: `${app.name} is a learned app of the ${where} browser; this helper works in profile '${profile.name}', and ${own} is not signed in to ${host}. ${fix} Tell the main agent this if you cannot do it yourself.`,
  }
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
      const partition = deps.partitionOf(profile?.id ?? null)
      const app = learnedRun ? (deps.learned?.find(str(input['app'])) ?? null) : null
      if (app !== null) {
        const access = await learnedAccess(app, profile, deps)
        if (!access.ok) return access.message
      }
      if (learnedList && profile !== null) {
        const out = await tool.run(input, ctx)
        const allowed: string[] = []
        for (const a of deps.learned?.apps() ?? []) if ((await learnedAccess(a, profile, deps)).ok) allowed.push(a.name)
        return `You (profile ${profile.name}) may run: ${allowed.length === 0 ? 'none of these (none is in your profile or signed in in your browser)' : allowed.join(', ')}.\n\n${out}`
      }
      if (browser) deps.usePartition?.(partition)
      const saving = learnedSave ? slugOf(str(input['name']).trim()) : ''
      const before = saving === '' ? null : (deps.learned?.find(saving) ?? null)
      const out = await tool.run(input, ctx)
      // Record where the app worked, so it follows that browser's sign-in from now on.
      if (app !== null && ranOk(out)) deps.learned?.notePartition(app.id, partition, partitionsOfApp(app, deps))
      if (learnedSave && out.startsWith('Saved ')) {
        const id = saving
        if (id !== '') {
          deps.learned?.notePartition(id, partition, before === null || before.id !== id ? [] : partitionsOfApp(before, deps))
          if (profile !== null && !profile.general) deps.addLearned?.(profile.id, id)
        }
      }
      return out
    },
  }
}

/** A learned tool's result that shows the page answered (not refused, declined or failed). */
function ranOk(out: string): boolean {
  return !/^(Error:|DECLINED|Missing input|No saved app|args must be)/.test(out) && !/ has no tool /.test(out.slice(0, 200))
}
