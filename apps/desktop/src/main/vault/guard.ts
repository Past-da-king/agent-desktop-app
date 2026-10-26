/**
 * The vault guard: wraps every tool an agent has (toolset.ts), on the computer and on a headless node alike, so
 *
 *   - `{{vault:ref}}` / `{{vault:ref.field}}` in a tool's input is put in at the last moment, inside the app, for the
 *     tools that send or type things (fetch, page fields, a worker's key, a file, an app call). A shell command gets
 *     it as an environment variable instead (shell.ts), run_code as a literal in its scratch file (code.ts);
 *   - every vault value is taken out of what comes back (the result the model reads, the activity line, the run
 *     record the chat row keeps, approval cards and questions), shown as [vault:ref];
 *   - a call meant for another device (`device`) is passed on untouched: that device fills it from its own vault, so a
 *     value never travels to a phone.
 *
 * vault_reveal is the one tool whose result is not scrubbed: the person approved it (or the item allows it). The
 * row store scrubs it again before anything is written down (vault/redact.ts), so it is not kept.
 */
import type { JsonObject, Tool, ToolContext } from '@agent/core'

import { recordRun, takeRun, type ToolRun } from '../tools/run-capture'
import { fillInput, hasPlaceholder, vaultRuns, type VaultResolved, type VaultRun } from './placeholders'
import type { VaultStore } from './store'

/** Tools whose text input may carry placeholders, filled in before the tool sees it. */
export const VAULT_FILL_TOOLS: ReadonlySet<string> = new Set([
  'browser_fetch',
  'web_fetch',
  'browser_act',
  'browser_type',
  'browser_eval',
  'browser_fix',
  'worker_secret_set',
  'files_write',
  'apps_run',
  'webapp_run',
  'webapp_test',
  'browser_guide',
])

/** Tools that fill placeholders themselves (they need the value where only they know the shell or language). */
export const VAULT_SELF_TOOLS: ReadonlySet<string> = new Set(['shell_run', 'run_code'])

/** Results these tools give are the value on purpose. */
const UNSCRUBBED: ReadonlySet<string> = new Set(['vault_reveal'])

const wrapped = new WeakSet<Tool>()

export function envNameFor(ref: string, field: string): string {
  return `VAULT_${ref}_${field}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 120)
}

/** The resolver a tool call gets: items visible to its profile only; each use is counted. */
export function vaultRunFor(vault: VaultStore, ctx: Pick<ToolContext, 'profile'>): VaultRun {
  return {
    env: {},
    wroteValue: false,
    resolve: (raw: string): VaultResolved | { error: string } => {
      const hit = vault.resolve(raw, undefined, ctx.profile)
      if ('error' in hit) return hit
      vault.markUsed(hit.item.id)
      return { value: hit.value, label: `[vault:${hit.item.ref}]`, env: envNameFor(hit.item.ref, hit.field) }
    },
  }
}

export function guardTools(tools: Tool[], vault: VaultStore | undefined): Tool[] {
  if (vault === undefined) return tools
  return tools.map((tool) => guardTool(tool, vault))
}

export function guardTool(tool: Tool, vault: VaultStore): Tool {
  if (wrapped.has(tool)) return tool
  const name = tool.spec.name
  const guarded: Tool = {
    spec: tool.spec,
    run: async (input, ctx) => {
      const scrub = (text: string): string => (vault.count() === 0 ? text : vault.redact(text))
      const elsewhere = typeof input['device'] === 'string' && input['device'].trim() !== ''
      const run = vaultRunFor(vault, ctx)
      let used: JsonObject = input
      if (!elsewhere && VAULT_FILL_TOOLS.has(name)) {
        // A guide step whose value is a Vault item is sensitive: never shown, kept or left on the clipboard.
        const marked = name === 'browser_guide' ? markVaultSteps(input) : input
        const filled = fillInput(marked, run)
        if ('error' in filled) return filled.error
        used = filled.value as JsonObject
      }
      const safeCtx = scrubbedContext(ctx, scrub)
      let result: string
      try {
        result = elsewhere ? await tool.run(used, safeCtx) : await vaultRuns.run(run, () => tool.run(used, safeCtx))
      } catch (error) {
        throw new Error(scrub(error instanceof Error ? error.message : String(error)))
      } finally {
        // The record of what ran is the person's copy in the chat row: scrubbed too, and kept on the call's own input.
        const record = takeRun(used) ?? (used === input ? undefined : takeRun(input))
        if (record !== undefined) recordRun(input, scrubRun(record, scrub))
      }
      return UNSCRUBBED.has(name) ? result : scrub(result)
    },
  }
  wrapped.add(guarded)
  return guarded
}

/** browser_guide: each step (or the single target) whose value holds a {{vault:...}} placeholder gets sensitive: true. */
export function markVaultSteps(input: JsonObject): JsonObject {
  const mark = (step: unknown): unknown => {
    if (step === null || typeof step !== 'object' || Array.isArray(step)) return step
    const o = step as JsonObject
    return typeof o['value'] === 'string' && hasPlaceholder(o['value']) ? { ...o, sensitive: true } : o
  }
  const top = mark(input) as JsonObject
  return Array.isArray(input['steps']) ? { ...top, steps: input['steps'].map(mark) as JsonObject[] } : top
}

function scrubRun(run: ToolRun, scrub: (text: string) => string): ToolRun {
  return {
    ...run,
    input: scrub(run.input),
    stdout: scrub(run.stdout),
    stderr: scrub(run.stderr),
    ...(run.cwd === undefined ? {} : { cwd: scrub(run.cwd) }),
    ...(run.note === undefined ? {} : { note: scrub(run.note) }),
  }
}

function scrubJson(meta: JsonObject | undefined, scrub: (text: string) => string): JsonObject | undefined {
  if (meta === undefined) return undefined
  try {
    return JSON.parse(scrub(JSON.stringify(meta))) as JsonObject
  } catch {
    return meta
  }
}

/** The context a guarded tool sees: anything it shows the person has vault values taken out. */
function scrubbedContext(ctx: ToolContext, scrub: (text: string) => string): ToolContext {
  return {
    ...ctx,
    activity: (text, meta) => ctx.activity(scrub(text), scrubJson(meta, scrub)),
    updateActivity: (id, text, meta) => ctx.updateActivity(id, scrub(text), scrubJson(meta, scrub)),
    ask: (question, options, card) => ctx.ask(scrub(question), options.map(scrub), scrubJson(card, scrub)),
    approve: (summary, details, scope) => ctx.approve(scrub(summary), details === undefined ? undefined : scrub(details), scope),
    notify: (title, body) => ctx.notify(scrub(title), scrub(body)),
  }
}
