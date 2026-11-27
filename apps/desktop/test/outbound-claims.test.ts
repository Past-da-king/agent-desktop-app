import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OutboundClaims } from '../src/main/runtime/outbound-claims'

describe('authority claims', () => {
  it('grants one caller, returns the result and keeps tokens out of the ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbound-claims-'))
    const path = join(dir, 'claims.sqlite')
    const a = new OutboundClaims(path), b = new OutboundClaims(path)
    try {
      expect(a.claim('hash-of-turn-target-content', 'brain-a')).toEqual({ state: 'granted', owner: 'brain-a' })
      expect(b.claim('hash-of-turn-target-content', 'brain-b')).toEqual({ state: 'in_progress' })
      expect(b.finish('hash-of-turn-target-content', 'brain-b', { state: 'sent', result: 'bad' })).toBe(false)
      expect(a.finish('hash-of-turn-target-content', 'brain-a', { state: 'sent', result: 'permalink' })).toBe(true)
      expect(b.claim('hash-of-turn-target-content', 'brain-b')).toEqual({ state: 'sent', result: 'permalink' })
      expect(readFileSync(path).includes('sample-secret-token')).toBe(false)
    } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('permits definite failure retry and holds unknown', () => {
    const a = new OutboundClaims(':memory:')
    expect(a.claim('a', 'one').state).toBe('granted')
    expect(a.finish('a', 'one', { state: 'failed' })).toBe(true)
    expect(a.claim('a', 'two').state).toBe('granted')
    expect(a.finish('a', 'two', { state: 'unknown' })).toBe(true)
    expect(a.claim('a', 'three').state).toBe('unknown')
    a.close()
  })
})
