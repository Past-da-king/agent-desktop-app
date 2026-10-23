/**
 * `{{vault:ref}}` and `{{vault:ref.field}}`: how an agent uses a secret it cannot see.
 *
 * The vault guard (guard.ts) runs every tool call inside a VaultRun. Tools that take free text (a fetch header, a
 * page field, a worker key) get the placeholder replaced by the value in their input. A shell command instead gets an
 * environment variable (VAULT_<REF>_<FIELD>) and a reference to it in the command, so the value is never on the
 * command line or on the approval card. run_code gets the value as a string literal in its scratch file, which is
 * removed when the run ends.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import { VAULT_PLACEHOLDER } from '@agent/core'

export interface VaultResolved {
  value: string
  /** What it reads as in any result: [vault:groq]. */
  label: string
  /** The environment variable a shell gets it in. */
  env: string
}

export interface VaultRun {
  resolve(raw: string): VaultResolved | { error: string }
  /** Environment variables the command run inside this call needs. */
  env: Record<string, string>
  /** Something was put into a scratch file that must go when the run ends. */
  wroteValue: boolean
}

export const vaultRuns = new AsyncLocalStorage<VaultRun>()

export function hasPlaceholder(text: string): boolean {
  VAULT_PLACEHOLDER.lastIndex = 0
  const found = VAULT_PLACEHOLDER.test(text)
  VAULT_PLACEHOLDER.lastIndex = 0
  return found
}

/** Replace every placeholder in a text with its value. An error names the first one that does not resolve. */
export function fillText(text: string, run: VaultRun): { text: string } | { error: string } {
  let error: string | null = null
  const out = text.replace(VAULT_PLACEHOLDER, (whole, raw: string) => {
    if (error !== null) return whole
    const hit = run.resolve(raw)
    if ('error' in hit) {
      error = hit.error
      return whole
    }
    return hit.value
  })
  return error === null ? { text: out } : { error }
}

/** Every string in a tool input with placeholders filled in. The original object is left as it was. */
export function fillInput(value: unknown, run: VaultRun): { value: unknown } | { error: string } {
  if (typeof value === 'string') {
    if (!hasPlaceholder(value)) return { value }
    const filled = fillText(value, run)
    return 'error' in filled ? filled : { value: filled.text }
  }
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) {
      const next = fillInput(item, run)
      if ('error' in next) return next
      out.push(next.value)
    }
    return { value: out }
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = fillInput(item, run)
      if ('error' in next) return next
      out[key] = next.value
    }
    return { value: out }
  }
  return { value }
}

export type ShellKind = 'posix' | 'powershell' | 'cmd'

/**
 * A shell command with each placeholder turned into a reference to an environment variable that holds the value.
 * Quote-aware, so `curl -H 'Authorization: Bearer {{vault:x}}'` still works: inside single quotes the quote is
 * closed around the reference.
 */
export function shellCommand(command: string, kind: ShellKind, run: VaultRun): { command: string } | { error: string } {
  if (!hasPlaceholder(command)) return { command }
  let out = ''
  let quote: '' | "'" | '"' = ''
  let i = 0
  while (i < command.length) {
    VAULT_PLACEHOLDER.lastIndex = i
    const match = VAULT_PLACEHOLDER.exec(command)
    if (match !== null && match.index === i) {
      const hit = run.resolve(match[1]!)
      if ('error' in hit) return { error: hit.error }
      run.env[hit.env] = hit.value
      out += referenceFor(hit, kind, quote)
      i += match[0].length
      continue
    }
    const ch = command[i]!
    if (kind === 'posix') {
      if (quote === '' && ch === '\\' && i + 1 < command.length) {
        out += ch + command[i + 1]!
        i += 2
        continue
      }
      if (quote === '"' && ch === '\\' && i + 1 < command.length) {
        out += ch + command[i + 1]!
        i += 2
        continue
      }
      if (ch === "'" && quote !== '"') quote = quote === "'" ? '' : "'"
      else if (ch === '"' && quote !== "'") quote = quote === '"' ? '' : '"'
    } else if (kind === 'powershell') {
      if (ch === '`' && quote !== "'" && i + 1 < command.length) {
        out += ch + command[i + 1]!
        i += 2
        continue
      }
      if (ch === "'" && quote !== '"') quote = quote === "'" ? '' : "'"
      else if (ch === '"' && quote !== "'") quote = quote === '"' ? '' : '"'
    }
    out += ch
    i += 1
  }
  VAULT_PLACEHOLDER.lastIndex = 0
  return { command: out }
}

function referenceFor(hit: VaultResolved, kind: ShellKind, quote: '' | "'" | '"'): string {
  if (kind === 'cmd') return `%${hit.env}%`
  if (kind === 'powershell') {
    // Inside '...' nothing expands, so the value itself goes in, with ' doubled as PowerShell escapes it.
    if (quote === "'") return hit.value.replace(/'/g, "''")
    if (quote === '"') return `$($env:${hit.env})`
    return `"$env:${hit.env}"`
  }
  if (quote === "'") return `'"\${${hit.env}}"'`
  if (quote === '"') return `\${${hit.env}}`
  return `"\${${hit.env}}"`
}

/**
 * Code for run_code with each placeholder turned into the value: escaped for the string it sits in, or a quoted
 * string literal when it stands on its own. Works the same for JavaScript and Python.
 */
export function codeText(code: string, run: VaultRun): { code: string } | { error: string } {
  if (!hasPlaceholder(code)) return { code }
  let out = ''
  let quote = ''
  let i = 0
  while (i < code.length) {
    VAULT_PLACEHOLDER.lastIndex = i
    const match = VAULT_PLACEHOLDER.exec(code)
    if (match !== null && match.index === i) {
      const hit = run.resolve(match[1]!)
      if ('error' in hit) return { error: hit.error }
      const escaped = JSON.stringify(hit.value).slice(1, -1).replace(/'/g, "\\'").replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
      out += quote === '' ? JSON.stringify(hit.value) : escaped
      run.wroteValue = true
      i += match[0].length
      continue
    }
    const ch = code[i]!
    if (quote !== '' && ch === '\\' && i + 1 < code.length) {
      out += ch + code[i + 1]!
      i += 2
      continue
    }
    if (quote === '' && (ch === '"' || ch === "'" || ch === '`')) quote = ch
    else if (quote !== '' && ch === quote) quote = ''
    out += ch
    i += 1
  }
  VAULT_PLACEHOLDER.lastIndex = 0
  return { code: out }
}

/** The run this tool call is part of, if any. */
export function currentVaultRun(): VaultRun | undefined {
  return vaultRuns.getStore()
}

/** The environment variables a command needs for its placeholders (empty outside a vault run). */
export function vaultEnv(): Record<string, string> {
  return { ...(vaultRuns.getStore()?.env ?? {}) }
}
