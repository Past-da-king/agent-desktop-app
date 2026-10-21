/**
 * What each chat's own agent last ran on (account, model, family, the divider it was on), kept under userData so a
 * restart does not switch a chat's engine mid-conversation. See runtime/brains.ts for the rule it serves.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { BrainLock, BrainLocks } from './runtime/brains'

const MAX_LOCKS = 400

export class FileBrainLocks implements BrainLocks {
  private data: Record<string, BrainLock> = {}

  constructor(private readonly file: string) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [chat, raw] of Object.entries(parsed as Record<string, unknown>)) {
          const lock = lockFrom(raw)
          if (lock !== null) this.data[chat] = lock
        }
      }
    } catch {
      // No file yet, or a damaged one: no chat is locked to anything.
    }
  }

  get(chat: string): BrainLock | null {
    return this.data[chat] ?? null
  }

  set(chat: string, lock: BrainLock): void {
    const current = this.data[chat]
    if (current !== undefined && current.account === lock.account && current.model === lock.model && current.family === lock.family && current.divider === lock.divider) return
    this.data[chat] = lock
    const keys = Object.keys(this.data)
    if (keys.length > MAX_LOCKS) for (const key of keys.slice(0, keys.length - MAX_LOCKS)) delete this.data[key]
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 })
      renameSync(temp, this.file)
    } catch {
      // Remembering is a nicety; the chat still runs.
    }
  }
}

function lockFrom(raw: unknown): BrainLock | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const family = o['family']
  if (typeof o['account'] !== 'string' || (family !== 'api' && family !== 'plan:claude' && family !== 'plan:codex')) return null
  return { account: o['account'], model: typeof o['model'] === 'string' ? o['model'] : '', family, divider: typeof o['divider'] === 'number' ? o['divider'] : 0 }
}
