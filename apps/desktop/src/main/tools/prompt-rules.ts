/**
 * prompt_rules: the person's standing instructions for every agent (shared/prompt-rules.ts). He says "update the
 * system prompt: X" and the agent adds the rule; from the next run on, every agent's prompt carries it (main, project
 * chats, helpers, routines and desks, on any provider or plan, here and on his other devices), with no new build.
 *
 * No approval card (24 Oct 2026: he asked for it to just happen). Each change shows one line in the chat saying what
 * changed, and every version is kept with who changed it and why. The rules have their own section of the prompt,
 * below the app's own, which they cannot switch off.
 */
import { enumOf, schema, str, type PromptRuleRow, type Tool } from '@agent/core'

import type { DataStore } from '../runtime/data'
import { agentWriter } from '../memory/history'
import { activeRules, editedRule, findRule, newRule, removedRule, RULE_MAX_CHARS, shortId } from '../../shared/prompt-rules'

const ACTIONS = ['list', 'add', 'edit', 'remove', 'history'] as const

export function promptRuleTools(store: DataStore, now: () => number = Date.now): Tool[] {
  return [
    {
      spec: {
        name: 'prompt_rules',
        description:
          "The user's standing instructions, part of every agent's system prompt from the next run on (main agent, project chats, helpers, routines, on every device). Use it when the user says \"update the system prompt\", \"add a rule\", \"from now on always/never...\". action list: every rule with its id; add: a new rule (text, reason); edit: change one (id, text, reason); remove: take one out (id, reason); history: one rule's versions (id). Write a rule as a short instruction to every agent, in the user's own meaning. No approval needed; the chat shows what changed. Rules never switch off the app's own approvals.",
        schema: schema(['action'], {
          action: enumOf('What to do', ...ACTIONS),
          id: str('The rule id (or its first 8 characters) for edit, remove and history'),
          text: str('add and edit: the rule, as an instruction to every agent'),
          reason: str('Why, in a few words (kept in its history)'),
        }),
      },
      run: async (input, ctx) => {
        const action = typeof input['action'] === 'string' ? input['action'] : ''
        const text = typeof input['text'] === 'string' ? input['text'].trim() : ''
        const reason = typeof input['reason'] === 'string' ? input['reason'].trim() : ''
        const id = typeof input['id'] === 'string' ? input['id'].trim() : ''
        const by = agentWriter(ctx.agentLabel)
        const rows = await store.list('prompt_rule')

        if (action === 'list') {
          const active = activeRules(rows)
          if (active.length === 0) return 'No standing instructions yet.'
          return active.map((row) => `#${shortId(row.id)} ${row.text}${row.reason === '' ? '' : ` (why: ${row.reason})`}`).join('\n')
        }

        if (action === 'add') {
          if (text === '') return 'Pass the rule in text.'
          if (text.length > RULE_MAX_CHARS) return `A rule is at most ${RULE_MAX_CHARS} characters; split it or say it shorter.`
          const same = activeRules(rows).find((row) => row.text.trim().toLowerCase() === text.toLowerCase())
          if (same !== undefined) return `That rule is already there as #${shortId(same.id)}.`
          const saved = await store.upsert('prompt_rule', newRule(text, reason, by, now()))
          await ctx.activity(`Standing instruction added: ${clip(text, 120)}`, { tool: 'prompt_rules', line: true })
          return `Rule #${shortId(saved.id)} added. Every agent follows it from its next run.`
        }

        const row = findRule(rows, id)
        if (action !== 'edit' && action !== 'remove' && action !== 'history') return 'action must be list, add, edit, remove or history.'
        if (id === '') return 'Pass the rule id (prompt_rules list shows them).'
        if (row === null) return `No rule #${id}. prompt_rules list shows the ids.`

        if (action === 'history') return historyText(row)

        if (action === 'edit') {
          if (text === '') return 'Pass the new text of the rule in text.'
          if (text.length > RULE_MAX_CHARS) return `A rule is at most ${RULE_MAX_CHARS} characters.`
          const change = editedRule(row, text, reason, by, now())
          if (change === null) return `Rule #${shortId(row.id)} already says that.`
          await store.upsert('prompt_rule', change)
          await ctx.activity(`Standing instruction ${row.status === 'removed' ? 'restored' : 'changed'}: ${clip(text, 120)}`, { tool: 'prompt_rules', line: true })
          return `Rule #${shortId(row.id)} now says: ${text}`
        }

        const change = removedRule(row, reason, by, now())
        if (change === null) return `Rule #${shortId(row.id)} was already removed.`
        await store.upsert('prompt_rule', change)
        await ctx.activity(`Standing instruction removed: ${clip(row.text, 120)}`, { tool: 'prompt_rules', line: true })
        return `Rule #${shortId(row.id)} removed. Its history is kept; edit brings it back.`
      },
    },
  ]
}

function historyText(row: PromptRuleRow): string {
  const versions = Array.isArray(row.history) ? row.history : []
  if (versions.length === 0) return `Rule #${shortId(row.id)}: ${row.text} (no history kept)`
  return [
    `Rule #${shortId(row.id)}, ${row.status === 'removed' ? 'removed' : 'in force'}, newest first:`,
    ...[...versions].reverse().map((v) => `v${v.n} ${new Date(v.at).toISOString().slice(0, 16).replace('T', ' ')} ${v.change} by ${v.by}${v.reason === '' ? '' : ` (${v.reason})`}: ${v.text}`),
  ].join('\n')
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`
}
