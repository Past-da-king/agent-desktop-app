/**
 * A review workflow guard, shared by the desktop and headless toolsets.
 * This recognises explicit GitHub operations; it is not a sandbox for arbitrary programs.
 */
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { schema, str, type JsonObject, type Settings, type Tool, type ToolContext } from '@agent/core'
import type { DataStore } from './data'

export const PR_GATE_CHAT = 'pr-gate-audit'
export const ATTESTATION_FIELDS = [
  'reviewerAgentId', 'testProof', 'trialMergeAndSuite', 'featureFlagStates',
  'environmentChecks', 'skippedTests', 'diffHygiene', 'finalDescription',
] as const
export const GENERIC_CHECKLIST = [
  'Read the full final diff and callers. Have a different agent review the change and fix its findings.',
  'Prove the tests fail without the fix, then pass on the final head. Run typecheck, lint, build and the full suite.',
  'Trial-merge all your open PRs onto the current target and run the suite together.',
  'Test all feature-flag states, including off and unreadable, on every output and fallback.',
  'Check required environment variables for every branch and deployment target.',
  'List every skipped test and why. Check security, migrations and rollback.',
  'Check diff hygiene: no unintended mode changes, stray files, secrets or build artifacts.',
  'Re-read the PR description at the final head; state proof, effective configuration and remaining limits.',
].join('\n')

function object(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') { try { return object(JSON.parse(value)) } catch { return {} } }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function ready(value: unknown): boolean { return typeof value === 'string' && /ready\s+for\s+review/i.test(value) }
function api(url: string, method: string, body: unknown): boolean {
  const data = object(body)
  let path = url
  if (/^https?:/i.test(url)) {
    try { const parsed = new URL(url); if (parsed.hostname !== 'api.github.com') return false; path = parsed.pathname } catch { return false }
  }
  const write = /^(POST|PATCH|PUT)$/i.test(method)
  if (!write) return false
  if (/(^|\/)graphql(?:\?|$)/i.test(path))
    return /\b(markPullRequestReadyForReview|requestReviews)\s*\(/.test(String(data['query'] ?? ''))
  if (/\/pulls\/\d+\/requested_reviewers(?:\?|$)/i.test(path)) return true
  if (/\/pulls(?:\?|$)/i.test(path) && /^POST$/i.test(method)) return data['draft'] !== true && data['draft'] !== 'true'
  if (/\/pulls\/\d+(?:\?|$)/i.test(path)) return data['draft'] === false || data['draft'] === 'false'
  return /\/issues\/\d+\/comments(?:\?|$)/i.test(path) && ready(data['body'])
}

/** Retain shell quoting, so documentation strings are never treated as commands. */
function tokens(source: string): string[] {
  const out: string[] = []
  let word = '', quote = '', started = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (quote) {
      if (c === quote) { quote = ''; continue }
      if (c === '\\' && quote === '"' && /["\\$]/.test(source[i + 1] ?? '')) { word += source[++i]; continue }
      word += c; continue
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue }
    if (c === '\\' && i + 1 < source.length && /[\s'"\\]/.test(source[i + 1]!)) { word += source[++i]; started = true; continue }
    if (/\s/.test(c) || /[;&|\n,]/.test(c)) {
      if (started) { out.push(word); word = ''; started = false }
      if (/[;&|\n,]/.test(c)) out.push(';')
      continue
    }
    word += c; started = true
  }
  if (started) out.push(word)
  return out
}
function option(words: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < words.length; i++) for (const name of names) {
    if (words[i]?.toLowerCase() === name.toLowerCase()) return words[i + 1]
    if (words[i]?.startsWith(name + '=')) return words[i]!.slice(name.length + 1)
    if (/^-[a-zA-Z]$/.test(name) && words[i]?.startsWith(name) && words[i]!.length > 2) return words[i]!.slice(2)
  }
  return undefined
}
function command(words: string[], depth: number): boolean {
  if (depth > 8) return false
  let at = 0
  while (/^[\w_]+=/.test(words[at] ?? '') || words[at] === '&') at++
  const exe = (words[at] ?? '').split(/[\\/]/).pop()!.replace(/\.exe$/i, '').toLowerCase()
  const args = words.slice(at + 1)
  if (['echo','printf','grep','rg','cat','write-output','write-host'].includes(exe)) return false
  if (['env','sudo','command','exec','nohup'].includes(exe)) return command(args.filter(w => !w.startsWith('-')), depth + 1)
  if (['bash','sh','zsh','pwsh','powershell'].includes(exe)) {
    const index = args.findIndex(w => /^-(?:[a-z]*c|command)$/i.test(w))
    return index >= 0 && shell(args.slice(index + 1).join(' '), depth + 1)
  }
  if (['wsl','ssh'].includes(exe)) {
    const start = exe === 'ssh' ? 1 : args.findIndex(w => w === '--' || w === '-e') + 1
    return shell(args.slice(Math.max(0, start)).join(' '), depth + 1)
  }
  if (exe === 'gh') {
    // Global flags may precede the command.
    const pr = args.indexOf('pr'), rest = args.indexOf('api')
    if (pr >= 0) {
      const action = args[pr + 1]
      if (action === 'create') return !args.some(w => w === '--draft' || w === '-d' || w === '--draft=true')
      if (action === 'ready') return !args.includes('--undo')
      if (action === 'edit') return args.some(w => /^--add-reviewer(?:=|$)/.test(w))
      if (action === 'review-request' || action === 'request-review') return true
      if (action === 'comment') return ready(option(args, '--body', '-b')) || args.includes('--body-file') || args.includes('-F')
      return false
    }
    if (rest >= 0) {
      const path = args.slice(rest + 1).find(w => /^(?:repos\/|\/repos\/|https:\/\/|graphql$)/.test(w)) ?? ''
      const data: Record<string, unknown> = {}
      for (let i = 0; i < args.length; i++) {
        if (/^(?:-f|-F|--field|--raw-field)$/.test(args[i]!)) {
          const field = args[++i] ?? '', equals = field.indexOf('=')
          if (equals >= 0) data[field.slice(0, equals)] = field.slice(equals + 1)
        }
      }
      const method = option(args, '-X', '--method') ?? (Object.keys(data).length || args.includes('--input') ? 'POST' : 'GET')
      // Unreadable request bodies are held, rather than assumed to be drafts.
      return api(path, method, data)
    }
    return false
  }
  if (['curl','invoke-restmethod','irm','invoke-webrequest','iwr'].includes(exe)) {
    const url = args.find(w => /^https:\/\/api\.github\.com\//i.test(w)) ?? ''
    const body = option(args, '-d','--data','--data-raw','--data-binary','--json','-Body')
    const method = option(args,'-X','--request','-Method') ?? (body === undefined ? 'GET' : 'POST')
    return api(url, method, body)
  }
  if (['node','python','python3'].includes(exe)) {
    const code = option(args,'-e','--eval','-c') ?? ''
    return script(code)
  }
  return false
}
function script(code: string): boolean {
  // Literal fetch calls in browser_eval / run_code. Other arbitrary programs cannot be statically inspected.
  const url = code.match(/https:\/\/api\.github\.com\/[^'"\s)]+/)?.[0]
  if (!url || !/\b(fetch|requests\.(post|patch|put)|urlopen)\b/.test(code)) return false
  const method = code.match(/(?:method\s*[:=]\s*['"]|requests\.)(post|patch|put)/i)?.[1] ?? 'GET'
  return api(url, method, { draft: /\bdraft['"]?\s*:\s*true\b/.test(code), query: code, body: code })
}
function shell(source: string, depth = 0): boolean {
  // Remove heredoc bodies before splitting shell commands.
  source = source.replace(/<<-?\s*['"]?([\w]+)['"]?[^\n]*\n[\s\S]*?\n\1(?:\n|$)/g, '')
  const list = tokens(source), part: string[] = []
  for (const word of [...list, ';']) {
    if (word === ';') { if (command(part, depth)) return true; part.length = 0 }
    else part.push(word)
  }
  return false
}
export function reviewableCall(name: string, input: Record<string, unknown>): boolean {
  name = name.replace(/^mcp__agent__/, '')
  if (['shell_run','Bash','PowerShell','exec_command'].includes(name)) return shell(String(input['command'] ?? input['cmd'] ?? ''))
  if (name === 'device_tool') return reviewableCall(String(input['tool'] ?? ''), object(input['args']))
  if (name === 'browser_fetch') return api(String(input['url'] ?? ''), String(input['method'] ?? 'GET'), input['body'])
  if (name === 'browser_eval' || name === 'run_code') return script(String(input['js'] ?? input['code'] ?? ''))
  if (name === 'apps_run') {
    const slug = String(input['slug'] ?? '').toUpperCase(), args = object(input['arguments'])
    if (!slug.startsWith('GITHUB_')) return false
    if (/REQUEST.*REVIEW|MARK.*READY.*REVIEW/.test(slug)) return true
    if (/CREATE.*PULL_REQUEST/.test(slug)) return args['draft'] !== true
    if (/(UPDATE|EDIT).*PULL_REQUEST/.test(slug)) return args['draft'] === false
    if (/CREATE.*COMMENT/.test(slug)) return ready(args['body'])
    if (/GRAPHQL/.test(slug)) return /\b(markPullRequestReadyForReview|requestReviews)\s*\(/.test(String(args['query'] ?? ''))
  }
  return false
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
interface Pending { id: string; key: string; actor: string; expires: number; attestation?: Record<string,string> }
export class PrGate {
  private pending = new Map<string, Pending>()
  constructor(private store: DataStore, private settings: () => Settings, private now = Date.now) {}
  private actor(ctx: ToolContext): string { return (ctx.owner ?? ctx.agentLabel) + ':' + (ctx.chat ?? 'main') }
  private async log(ctx: ToolContext, tool: string, outcome: string, gateId: string, fields?: Record<string,string>): Promise<void> {
    await this.store.upsert('chat_item', {
      kind: 'pr_gate', text: outcome,
      // Never store shell commands, API headers or bodies: they may contain credentials.
      meta: JSON.stringify({chat: PR_GATE_CHAT, at: this.now(), actor: this.actor(ctx), device: hostname(), tool, gateId, outcome, attestation: fields ?? null}),
    })
  }
  async check(tool: string, input: JsonObject, ctx: ToolContext): Promise<string | null> {
    if (!this.settings().prGateEnabled || !reviewableCall(tool, input)) return null
    const actor = this.actor(ctx), key = createHash('sha256').update(canonical({ tool, input, actor })).digest('hex')
    const now = this.now()
    for (const [id,p] of this.pending) if (p.expires < now) this.pending.delete(id)
    const match = [...this.pending.values()].find(p => p.key === key && p.actor === actor)
    if (match?.attestation) {
      // Remove synchronously before awaiting a log write: concurrent calls cannot consume twice.
      this.pending.delete(match.id)
      await this.log(ctx, tool, 'passed once', match.id, match.attestation)
      return null
    }
    const pending = match ?? {id: randomUUID(), key, actor, expires: now + 10 * 60_000}
    this.pending.set(pending.id, pending)
    await this.log(ctx, tool, 'held for attestation', pending.id)
    const pages = await this.store.list('memory')
    const wanted = this.settings().prGateSkillPages
    const found = wanted.flatMap(title => pages.filter(p => p.title === title).map(p => '# ' + p.title + '\n' + p.body))
    const checklist = found.length ? found.join('\n\n') + (found.length < wanted.length ? '\n\nMissing policy pages: use the generic checklist too.\n' + GENERIC_CHECKLIST : '') : GENERIC_CHECKLIST
    return 'PR gate: NOT RUN. Gate id: ' + pending.id + '\n\n' + checklist +
      '\n\nCall pr_gate_attest with gateId and attestation containing non-empty evidence for: ' + ATTESTATION_FIELDS.join(', ') +
      '. reviewerAgentId must identify a different agent. Explain legitimate absences with evidence; empty or n/a boilerplate is refused. Then reissue this exact tool and arguments within ten minutes. Permission is bound to this agent and chat and passes once.'
  }
  async attest(id: string, value: unknown, ctx: ToolContext): Promise<string> {
    const p = this.pending.get(id), actor = this.actor(ctx), fields = object(value)
    let reason = ''
    if (!this.settings().prGateEnabled) reason = 'PR gate is off'
    else if (!p || p.actor !== actor || p.expires < this.now()) reason = 'unknown, expired, consumed or another agent?s gate'
    else if (p.attestation) reason = 'already attested'
    else if (ATTESTATION_FIELDS.some(k => typeof fields[k] !== 'string' || String(fields[k]).trim().length < (k === 'reviewerAgentId' ? 1 : 8) || /^(n\/?a|none|not applicable|yes|done|true|ok|passed)[.!]?$/i.test(String(fields[k]).trim()))) reason = 'every field needs specific evidence, not boilerplate'
    else if ([ctx.owner, ctx.agentLabel, actor].filter(Boolean).map(id => id!.toLowerCase()).includes(String(fields['reviewerAgentId']).trim().toLowerCase())) reason = 'reviewer must be a different agent'
    if (reason) { await this.log(ctx, 'pr_gate_attest', 'refused: ' + reason, id); return 'Refused: ' + reason }
    const evidence = Object.fromEntries(ATTESTATION_FIELDS.map(k => [k,String(fields[k]).trim().slice(0,4000)]))
    p!.attestation = evidence
    await this.log(ctx, 'pr_gate_attest', 'attested', id, evidence)
    return 'Attestation recorded. Reissue the identical held call once before its ten-minute expiry.'
  }
  tools(): Tool[] {
    return [{
      spec: { name: 'pr_gate_attest', description: 'Attest the completed independent PR vetting evidence for a held PR gate. Reissue the identical held call afterwards; it passes once within ten minutes.', schema: schema(['gateId','attestation'], { gateId: str('Gate id returned by PR gate'), attestation: { type: 'object', properties: Object.fromEntries(ATTESTATION_FIELDS.map(k => [k,str('Specific evidence for ' + k)])), required: [...ATTESTATION_FIELDS], additionalProperties: false } }) },
      run: async (input,ctx) => this.attest(String(input['gateId'] ?? ''), input['attestation'], ctx),
    }]
  }
}
const gates = new WeakMap<DataStore,PrGate>()
export function prGateFor(store: DataStore, settings: () => Settings): PrGate {
  let gate = gates.get(store)
  if (!gate) { gate = new PrGate(store, settings); gates.set(store,gate) }
  return gate
}
export function withPrGate(tools: Tool[], gate: PrGate): Tool[] {
  return tools.map(tool => ({
    spec: tool.spec,
    run: async (input,ctx) => (await gate.check(tool.spec.name,input,ctx)) ?? tool.run(input,ctx),
  }))
}
