/**
 * Secrets at rest: the AI key and the sync token. They never touch settings.json or the renderer.
 *
 * Production passes Electron's `safeStorage`, so the bytes are encrypted by the OS keychain. When
 * encryption is unavailable (some Linux setups) we still store the value, but in a 0600 file under a
 * 0700 folder, and Settings shows a visible warning (PLAN.md 7).
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export type SecretName = 'apiKey' | 'syncToken' | 'composioKey'

export class Secrets {
  private readonly dir: string
  private readonly storage: SafeStorageLike

  constructor(dir: string, storage: SafeStorageLike) {
    this.dir = dir
    this.storage = storage
  }

  /** True when the OS keychain backs the files on this computer. */
  encryptedAtRest(): boolean {
    return this.storage.isEncryptionAvailable()
  }

  get(name: string): string | null {
    const file = this.fileFor(name)
    try {
      const bytes = readFileSync(file)
      if (this.storage.isEncryptionAvailable()) return this.storage.decryptString(bytes)
      return bytes.toString('utf8')
    } catch {
      return null
    }
  }

  set(name: string, value: string): void {
    const file = this.fileFor(name)
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    if (this.storage.isEncryptionAvailable()) {
      writeFileSync(file, this.storage.encryptString(value), { mode: 0o600 })
    } else {
      writeFileSync(file, value, { encoding: 'utf8', mode: 0o600 })
    }
    try {
      chmodSync(file, 0o600)
    } catch {
      // Windows has no POSIX mode; the file already lives under the user's profile.
    }
  }

  delete(name: string): void {
    rmSync(this.fileFor(name), { force: true })
  }

  private fileFor(name: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error(`Invalid secret name: ${name}`)
    return join(this.dir, `${name}.secret`)
  }
}
