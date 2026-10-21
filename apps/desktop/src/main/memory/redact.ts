/**
 * Secret redaction for anything written into long-term memory (filed chats and imported banks). Memory syncs and is
 * read back into every prompt, so a key, password or token must never land there. People's names, emails and
 * phone numbers are kept on purpose: they are what the person wants the agent to remember.
 */

export const REDACTED = '[REDACTED]'

interface Rule {
  label: string
  pattern: RegExp
  /** Replacement; `$1` keeps a captured label such as "password:". */
  replace: string
}

const RULES: Rule[] = [
  { label: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: REDACTED },
  { label: 'anthropic', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  { label: 'openai', pattern: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g, replace: REDACTED },
  { label: 'google', pattern: /\bAIza[0-9A-Za-z_-]{30,}/g, replace: REDACTED },
  { label: 'github', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g, replace: REDACTED },
  { label: 'gitlab', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g, replace: REDACTED },
  { label: 'slack', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
  { label: 'aws', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: REDACTED },
  { label: 'stripe', pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: REDACTED },
  { label: 'composio', pattern: /\b(?:ak|ck)_[A-Za-z0-9_-]{20,}/g, replace: REDACTED },
  { label: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  { label: 'bearer', pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g, replace: `$1 ${REDACTED}` },
  { label: 'url-credentials', pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, replace: `$1${REDACTED}@` },
  {
    label: 'labelled-secret',
    // "password: hunter2", "api_key=abc...", "client secret is xyz", "token -> abc": keep the label, drop the value.
    pattern:
      /\b((?:pass(?:word|wd|code)?|pwd|pin|api[ _-]?key|secret(?:[ _-]?key)?|client[ _-]?secret|access[ _-]?token|refresh[ _-]?token|auth[ _-]?token|token|otp|2fa(?:[ _-]?code)?|totp(?:[ _-]?seed)?|seed phrase|recovery code)s?)(\s*(?:is|was|=|:|->|=>)\s*)(["'`]?)([^\s"'`,;]{4,})\3/gi,
    replace: `$1$2${REDACTED}`,
  },
]

/** Words that follow a label like "password:" in prose and are not a secret value. */
const NOT_A_VALUE = /^(?:\[REDACTED]|required|optional|reset|manager|protected|field|less|login|changed|here|there|in|the|a|an|stored|saved|set|unset|none|null|empty|hidden|redacted|same|rotated|expired|missing|wrong|correct|valid|invalid)$/i

export interface Redaction {
  text: string
  /** How many secrets were taken out, per kind. */
  hits: Record<string, number>
  total: number
}

/** Takes every secret out of a piece of text. */
export function redactSecrets(input: string): Redaction {
  let text = input
  const hits: Record<string, number> = {}
  let total = 0
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      const match = String(args[0])
      if (rule.label === 'labelled-secret') {
        const value = String(args[4] ?? '')
        if (NOT_A_VALUE.test(value) || !looksLikeSecretValue(value)) return match
      }
      hits[rule.label] = (hits[rule.label] ?? 0) + 1
      total += 1
      return match.replace(new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', '')), rule.replace)
    })
  }
  return { text, hits, total }
}

/** A labelled value counts when it is not a plain English word: it has a digit, a symbol or mixed case. */
function looksLikeSecretValue(value: string): boolean {
  if (/^[a-z]+$/.test(value) && value.length < 16) return false
  return true
}

/** True when the text is little more than a secret: nothing worth remembering is left once it is taken out. */
export function mostlySecret(original: string, redacted: string): boolean {
  if (original === redacted) return false
  const left = redacted.split(REDACTED).join(' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return left.split(/\s+/).filter((word) => word.length > 2).length < 4
}
