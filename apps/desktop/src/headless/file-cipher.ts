/**
 * The headless node's stand-in for Electron's safeStorage: AES-256-GCM with a random 32-byte key kept in a 0600 file
 * (protocol s6: "a 0600 key file on the headless node"). The secrets stay unreadable to anyone who copies only the
 * secrets folder; anyone who can read the key file can read them, which is the same trust the OS keychain gives a
 * process running as the same user.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { SafeStorageLike } from '../main/secrets'

const MAGIC = Buffer.from('AGK1')

export class FileKeyCipher implements SafeStorageLike {
  private readonly key: Buffer

  constructor(keyFile: string) {
    this.key = loadOrMakeKey(keyFile)
  }

  isEncryptionAvailable(): boolean {
    return true
  }

  encryptString(plainText: string): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const body = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body])
  }

  decryptString(encrypted: Buffer): string {
    if (encrypted.length < MAGIC.length + 28 || !encrypted.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('Not a secret written by this node.')
    }
    const iv = encrypted.subarray(4, 16)
    const tag = encrypted.subarray(16, 32)
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]).toString('utf8')
  }
}

function loadOrMakeKey(file: string): Buffer {
  if (existsSync(file)) {
    const key = readFileSync(file)
    if (key.length !== 32) throw new Error(`The key file ${file} is damaged (expected 32 bytes).`)
    return key
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const key = randomBytes(32)
  writeFileSync(file, key, { mode: 0o600, flag: 'wx' })
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows has no POSIX mode; the folder already belongs to the user.
  }
  return key
}
