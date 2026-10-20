import { describe, expect, it } from 'vitest'

import { readMode, seedFor } from '../src/renderer/bridge/seed'
import { hashFor, parseHash } from '../src/renderer/state/route'

describe('renderer routes', () => {
  it('reads app and onboarding hashes', () => {
    expect(parseHash('#/home')).toEqual({ page: 'home' })
    expect(parseHash('#/settings')).toEqual({ page: 'settings' })
    expect(parseHash('#/onboarding/sync')).toEqual({ page: 'onboarding', step: 'sync' })
    expect(parseHash('#/onboarding/style')).toEqual({ page: 'onboarding', step: 'style' })
  })

  it('falls back for empty, unknown and unknown onboarding steps', () => {
    expect(parseHash('')).toBeNull()
    expect(parseHash('#/')).toBeNull()
    expect(parseHash('#/nowhere')).toBeNull()
    expect(parseHash('#/onboarding/nowhere')).toEqual({ page: 'onboarding', step: 'signin' })
  })

  it('writes hashes back the same way', () => {
    expect(hashFor({ page: 'memory' })).toBe('#/memory')
    expect(hashFor({ page: 'onboarding', step: 'ai' })).toBe('#/onboarding/ai')
  })
})

describe('mock seed modes', () => {
  it('chooses a mode from the query once', () => {
    expect(readMode('')).toBe('fresh')
    expect(readMode('?demo=1')).toBe('demo')
    expect(readMode('?demo=empty')).toBe('empty')
    expect(readMode('?demo=big')).toBe('big')
  })

  it('starts fresh with no data and no onboarding', () => {
    const seed = seedFor('fresh')
    expect(seed.settings.onboarded).toBe(false)
    expect(seed.rows.task).toHaveLength(0)
    expect(seed.rows.chat_item).toHaveLength(0)
  })

  it('seeds the demo persona and its data', () => {
    const seed = seedFor('demo')
    expect(seed.settings.onboarded).toBe(true)
    expect(seed.settings.agentName).toBe('Nova')
    expect(seed.rows.goal.length).toBeGreaterThanOrEqual(3)
    expect(seed.rows.memory.length).toBeGreaterThanOrEqual(6)
    expect(seed.rows.chat_item.some((item) => item.kind === 'approval')).toBe(true)
  })

  it('has no data in the empty mode but is onboarded', () => {
    const seed = seedFor('empty')
    expect(seed.settings.onboarded).toBe(true)
    expect(seed.rows.memory).toHaveLength(0)
  })

  it('adds long lists and an unbroken long title in big mode', () => {
    const seed = seedFor('big')
    expect(seed.rows.task.length).toBeGreaterThanOrEqual(40)
    expect(seed.rows.memory.length).toBeGreaterThanOrEqual(40)
    expect(seed.rows.trigger.length).toBeGreaterThanOrEqual(12)
    expect(seed.rows.chat_item.length).toBeGreaterThanOrEqual(60)
    expect(seed.rows.task.some((task) => task.title.length >= 80 && !task.title.includes(' '))).toBe(true)
  })
})
