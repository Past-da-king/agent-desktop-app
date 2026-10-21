import { describe, expect, it } from 'vitest'

import { REDACTED, mostlySecret, redactSecrets } from '../src/main/memory/redact'

describe('secret redaction', () => {
  it('takes out provider keys, tokens and private keys', () => {
    const samples = [
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
      'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123',
      'AIzaSyA1234567890abcdefghijklmnopqrstu',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ',
      'glpat-abcdefghij0123456789',
      'xoxb-1234567890-abcdefghijkl',
      'AKIAABCDEFGHIJKLMNOP',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
    ]
    for (const secret of samples) {
      const out = redactSecrets(`here it is: ${secret} ok`)
      expect(out.text, secret).not.toContain(secret)
      expect(out.text).toContain(REDACTED)
      expect(out.total).toBeGreaterThan(0)
    }
  })

  it('keeps the label and drops the value', () => {
    expect(redactSecrets('Password: Hunter2024!').text).toBe(`Password: ${REDACTED}`)
    expect(redactSecrets('api_key=abc123def456').text).toBe(`api_key=${REDACTED}`)
    expect(redactSecrets('PIN: 4821').text).toBe(`PIN: ${REDACTED}`)
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop0123456789').text).toBe(`Authorization: Bearer ${REDACTED}`)
    expect(redactSecrets('postgres://admin:s3cret@localhost:5432/db').text).toBe(`postgres://${REDACTED}@localhost:5432/db`)
  })

  it('leaves prose, people and contact details alone', () => {
    const prose = [
      'The password is required on the second screen.',
      'The token is short-lived (about an hour).',
      'Reset password: use the link in the email.',
      'Call Nomsa on 082 555 0101 or email nomsa@example.com.',
      'The salvage pass is cheap, not optional.',
      'Use the --purple token: it fails contrast.',
      'Commit 0ff4f35c745882350c73cd27009304308108e366 holds the fix.',
    ]
    for (const line of prose) expect(redactSecrets(line).text, line).toBe(line)
  })

  it('knows when nothing but a secret is left', () => {
    const raw = 'Key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345'
    expect(mostlySecret(raw, redactSecrets(raw).text)).toBe(true)
    const rich = 'Sam keeps the Acme billing login in the shared vault; the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345 rotates monthly.'
    expect(mostlySecret(rich, redactSecrets(rich).text)).toBe(false)
  })
})
