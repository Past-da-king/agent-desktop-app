import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { Secrets, type SafeStorageLike } from '../src/main/secrets'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-secrets-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A stand-in for safeStorage. It base64s and marks the text, which is enough to prove the file is not plain. */
function fakeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`vault:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (encrypted) => {
      const text = encrypted.toString('utf8')
      if (!text.startsWith('vault:')) throw new Error('not encrypted by this storage')
      return Buffer.from(text.slice('vault:'.length), 'base64').toString('utf8')
    },
  }
}

describe('Secrets', () => {
  it('round trips a secret through the encrypted path and leaves nothing readable on disk', () => {
    const dir = tempDir()
    const secrets = new Secrets(dir, fakeStorage(true))

    secrets.set('apiKey', 'sk-test-very-secret')

    expect(secrets.get('apiKey')).toBe('sk-test-very-secret')
    expect(secrets.encryptedAtRest()).toBe(true)
    const onDisk = readFileSync(join(dir, 'apiKey.secret'), 'utf8')
    expect(onDisk).not.toContain('sk-test-very-secret')
    expect(onDisk.startsWith('vault:')).toBe(true)
  })

  it('falls back to a 0600 plain file when the OS has no encryption', () => {
    const dir = tempDir()
    const secrets = new Secrets(dir, fakeStorage(false))

    secrets.set('syncToken', 'token-123')

    const file = join(dir, 'syncToken.secret')
    expect(secrets.get('syncToken')).toBe('token-123')
    expect(secrets.encryptedAtRest()).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('token-123')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('returns null for a missing name and never throws on delete of a name that is not there', () => {
    const dir = tempDir()
    const secrets = new Secrets(dir, fakeStorage(true))

    expect(secrets.get('apiKey')).toBeNull()
    expect(() => secrets.delete('apiKey')).not.toThrow()
    expect(() => secrets.delete('syncToken')).not.toThrow()
  })

  it('deletes only the named secret', () => {
    const dir = tempDir()
    const secrets = new Secrets(dir, fakeStorage(true))
    secrets.set('apiKey', 'key-one')
    secrets.set('syncToken', 'token-one')

    secrets.delete('apiKey')

    expect(secrets.get('apiKey')).toBeNull()
    expect(secrets.get('syncToken')).toBe('token-one')
  })

  it('rejects a name that could escape the secrets folder', () => {
    const dir = tempDir()
    const secrets = new Secrets(dir, fakeStorage(true))

    expect(() => secrets.get('../outside')).toThrow()
    expect(() => secrets.set('a/b', 'x')).toThrow()
  })
})
