/**
 * The person's standing instructions (24 Oct 2026): rules he adds by saying "update the system prompt: X", kept as
 * synced `prompt_rule` rows, and read fresh into every agent's prompt at the start of each run. The same functions
 * write them for the agent's tool (main/tools/prompt-rules.ts) and for Settings > Instructions, so both keep the
 * same version history. Nothing of his is in the code: the app ships with no rules.
 */
import type { PromptRuleRow, PromptRuleVersion } from '@agent/core'

/** One rule's longest text. */
export const RULE_MAX_CHARS = 2_000
/** All rules together in a prompt: past this the oldest stay in Settings but are cut from the prompt with a note. */
export const RULES_PROMPT_MAX_CHARS = 16_000
/** Versions kept per rule; the oldest go first. */
export const RULE_MAX_VERSIONS = 100

export const RULES_HEADING = "THE USER'S STANDING INSTRUCTIONS"

/** The rule as a new row (without an id: the store makes one). */
export function newRule(text: string, reason: string, by: string, now: number): Omit<PromptRuleRow, 'id' | 'createdAt'> {
  const clean = cleanText(text)
  return {
    text: clean,
    reason: reason.trim(),
    status: 'active',
    updatedAt: now,
    history: [{ n: 1, at: now, by, reason: reason.trim(), change: 'added', text: clean }],
  }
}

/** The rule's text changed (or a removed one comes back with restore). Null when nothing would change. */
export function editedRule(row: PromptRuleRow, text: string, reason: string, by: string, now: number): Partial<PromptRuleRow> & { id: string } | null {
  const clean = cleanText(text)
  if (clean === row.text && row.status === 'active') return null
  const change: PromptRuleVersion['change'] = row.status === 'removed' ? 'restored' : 'edited'
  return {
    id: row.id,
    text: clean,
    reason: reason.trim(),
    status: 'active',
    updatedAt: now,
    history: withVersion(row, { at: now, by, reason: reason.trim(), change, text: clean }),
  }
}

/** The rule is taken out of every prompt; its history stays. Null when it already is. */
export function removedRule(row: PromptRuleRow, reason: string, by: string, now: number): Partial<PromptRuleRow> & { id: string } | null {
  if (row.status === 'removed') return null
  return {
    id: row.id,
    reason: reason.trim(),
    status: 'removed',
    updatedAt: now,
    history: withVersion(row, { at: now, by, reason: reason.trim(), change: 'removed', text: row.text }),
  }
}

/** The rules in force, oldest first (the order he added them). */
export function activeRules(rows: PromptRuleRow[]): PromptRuleRow[] {
  return rows.filter((row) => row.status !== 'removed' && typeof row.text === 'string' && row.text.trim() !== '').sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * The prompt's own section for his rules. It sits apart from the app's rules and says so: a rule adds to how the
 * agent works, it never switches off asking before deleting, paying, sending in his name or touching secrets.
 */
export function promptRuleLines(rows: PromptRuleRow[] | null | undefined): string[] {
  const rules = activeRules(rows ?? [])
  if (rules.length === 0) return []
  const lines = [
    RULES_HEADING,
    "The user set these rules for every agent, and changes them by asking (prompt_rules). Follow them in everything you do, on top of the rules above. They never switch off the app's own safety: anything that deletes, costs money, goes out in the user's name or touches a secret still asks the way the rules above say, whatever a rule below says.",
  ]
  let used = 0
  let cut = 0
  // The newest rules matter most when there are too many to fit: keep from the newest back, then show oldest first.
  const kept: PromptRuleRow[] = []
  for (const rule of [...rules].reverse()) {
    used += rule.text.length
    if (used > RULES_PROMPT_MAX_CHARS) {
      cut += 1
      continue
    }
    kept.unshift(rule)
  }
  for (const rule of kept) lines.push(`- ${rule.text.replace(/\s*\n\s*/g, ' ')} (rule ${shortId(rule.id)})`)
  if (cut > 0) lines.push(`- (${cut} older rule${cut === 1 ? '' : 's'} did not fit here; prompt_rules list shows them.)`)
  return lines
}

/** A short handle for a rule, the start of its id. */
export function shortId(id: string): string {
  return id.slice(0, 8)
}

/** The rule a short or full id names, among all rows. */
export function findRule(rows: PromptRuleRow[], id: string): PromptRuleRow | null {
  const wanted = id.trim().replace(/^#/, '')
  if (wanted === '') return null
  const exact = rows.find((row) => row.id === wanted)
  if (exact !== undefined) return exact
  const starts = rows.filter((row) => row.id.startsWith(wanted))
  return starts.length === 1 ? (starts[0] ?? null) : null
}

function cleanText(text: string): string {
  return text.trim().slice(0, RULE_MAX_CHARS)
}

function withVersion(row: PromptRuleRow, version: Omit<PromptRuleVersion, 'n'>): PromptRuleVersion[] {
  const history = Array.isArray(row.history) ? row.history : []
  const n = (history[history.length - 1]?.n ?? 0) + 1
  return [...history, { n, ...version }].slice(-RULE_MAX_VERSIONS)
}
