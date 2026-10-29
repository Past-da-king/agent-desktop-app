/**
 * The secret check run on every file before the auto-commit stages it (git/autocommit.ts). A hit keeps that file out
 * of the commit and stops the push. What is found is named by kind only ("GitHub token"), never shown: the matched
 * text is not kept, logged or returned. Vault values are compared by hash: the scanner gets SHA-256 hashes of the
 * values (and their lengths), hashes the words of a file and looks them up, so no plain value is ever held here.
 *
 * A line that says `secret-scan:allow` (or `gitleaks:allow`) is skipped, for test fixtures that need a key-shaped
 * string on purpose.
 */
import { createHash } from 'node:crypto'

export interface SecretHit {
  /** The path relative to the repo root. */
  path: string
  /** What kind of secret, in plain words. Never the value. */
  kind: string
}

/** The vault's values as hashes: sha256 hex of each value, and the lengths there are. */
export interface VaultHashes {
  hashes: ReadonlySet<string>
  lengths: ReadonlySet<number>
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Hashes of the given values, for `VaultHashes`. Values shorter than 8 or with whitespace are left out. */
export function vaultHashesOf(values: Iterable<string>): VaultHashes {
  const hashes = new Set<string>()
  const lengths = new Set<number>()
  for (const value of values) {
    if (value.length < 8 || /\s/.test(value)) continue
    hashes.add(sha256(value))
    lengths.add(value.length)
  }
  return { hashes, lengths }
}

/** Files that hold secrets by their very name, whatever is in them. */
const SECRET_FILES: Array<{ test: (base: string) => boolean; kind: string }> = [
  { test: (base) => /^\.env(\..+)?$/i.test(base) && !/^\.env\.(example|sample|template|dist|defaults?)$/i.test(base), kind: 'an .env file' },
  { test: (base) => /\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx|asc|gpg)$/i.test(base) && !/\.pub(\.|$)/i.test(base), kind: 'a key file' },
  { test: (base) => /^id_(rsa|dsa|ecdsa|ed25519)(_[\w-]+)?$/i.test(base), kind: 'an SSH private key' },
  { test: (base) => /^(\.netrc|_netrc|\.pgpass|\.git-credentials|credentials)$/i.test(base), kind: 'a credentials file' },
]

/** Key-shaped text, by provider. */
const PATTERNS: Array<{ re: RegExp; kind: string }> = [
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/, kind: 'a private key' },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, kind: 'an AWS access key' },
  { re: /aws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/i, kind: 'an AWS secret key' },
  { re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/, kind: 'a GitHub token' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, kind: 'a Google API key' },
  { re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/, kind: 'a Google OAuth secret' },
  { re: /"private_key"\s*:\s*"-----BEGIN/, kind: 'a Google service account key' },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, kind: 'a Slack token' },
  { re: /\bxapp-\d-[A-Za-z0-9-]{10,}/, kind: 'a Slack app token' },
  { re: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/, kind: 'a Slack webhook' },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/, kind: 'an Anthropic key' },
  { re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}/, kind: 'an OpenAI key' },
  { re: /\bsk-[A-Za-z0-9]{40,}\b/, kind: 'an OpenAI-style key' },
  { re: /\bgsk_[A-Za-z0-9]{40,}/, kind: 'a Groq key' },
  { re: /\b[sr]k_live_[A-Za-z0-9]{20,}/, kind: 'a Stripe live key' },
  { re: /\bnpm_[A-Za-z0-9]{36}\b/, kind: 'an npm token' },
  { re: /:_authToken=(?!\$\{)[^\s]{8,}/, kind: 'an npm token' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, kind: 'a JWT' },
]

/** Config-like files, where `password = ...` with a real value is a secret. */
function isConfigFile(base: string): boolean {
  return /^\.env/i.test(base) || /\.(ini|cfg|conf|config|properties|ya?ml|toml|json|xml|npmrc|env)$/i.test(base) || /^(config|settings|secrets?)$/i.test(base)
}

const PASSWORD_LINE = /(?:^|[\s"'{,;])["']?(password|passwd|pwd|client_?secret|db_?pass(?:word)?)["']?\s*[:=]\s*["']?([^\s"',;}#]+)/i

/** A value that only points at a secret kept elsewhere, or a blank to fill in. */
function isPlaceholder(value: string): boolean {
  const v = value.trim()
  if (v.length < 6) return true
  if (/^[$%<{[(]/.test(v) || v.includes('process.env') || v.includes('${') || v.includes('{{')) return true
  return /^(changeme|change_me|password|passwd|secret|example|placeholder|your[_-]?\w*|x+|\*+|null|none|undefined|true|false|redacted|todo)$/i.test(v)
}

const ALLOW = /(?:secret-scan|gitleaks):allow/

function baseOf(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/** Is this file a secret by its name alone? Returns the kind, or null. */
export function secretByName(path: string): string | null {
  const base = baseOf(path)
  for (const rule of SECRET_FILES) if (rule.test(base)) return rule.kind
  return null
}

/** The words of a text a vault value could be, split on what no key contains. */
function wordsOf(line: string): string[] {
  const coarse = line.split(/[\s"'`,;()<>[\]{}]+/)
  const out = new Set<string>()
  for (const word of coarse) {
    if (word === '') continue
    out.add(word)
    for (const part of word.split(/[=:@/?&#|]+/)) if (part !== '') out.add(part)
  }
  return [...out]
}

/** What secret this text holds, or null. Binary text (a NUL in it) is not scanned for patterns. */
export function secretInText(path: string, text: string, vault?: VaultHashes): string | null {
  if (text.includes('\u0000')) return null
  const config = isConfigFile(baseOf(path))
  const checkVault = vault !== undefined && vault.hashes.size > 0
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 20_000) continue
    if (ALLOW.test(line)) continue
    for (const { re, kind } of PATTERNS) if (re.test(line)) return kind
    if (config) {
      const found = PASSWORD_LINE.exec(line)
      if (found !== null && !isPlaceholder(found[2] ?? '')) return 'a password in a config file'
    }
    if (checkVault) {
      for (const word of wordsOf(line)) {
        if (vault.lengths.has(word.length) && vault.hashes.has(sha256(word))) return 'a value from the Vault'
      }
    }
  }
  return null
}
