import { describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS } from '@agent/core'

import { buildSystemPrompt } from '../src/main/runtime/prompt'

const INPUT = {
  settings: { ...DEFAULT_SETTINGS, agentName: 'Nova', userName: 'Sam' },
  now: new Date('2026-10-20T08:00:00Z'),
  platform: 'win32',
  memories: [],
  goals: [],
  tasks: [],
  latestUserText: 'Check the news',
  timeZone: 'UTC',
}

describe('routine system prompt', () => {
  it('says it is a background routine nobody is watching', () => {
    const prompt = buildSystemPrompt({ ...INPUT, role: 'routine', routineName: 'Morning brief' })
    expect(prompt).toContain('ROUTINE RUN')
    expect(prompt).toContain('"Morning brief"')
    expect(prompt).toContain('Nobody is watching this run')
    expect(prompt).toContain('finish with a short summary')
    expect(prompt).toContain('Do not wait for an answer')
  })

  it('keeps the same voice and facts as the main prompt', () => {
    const prompt = buildSystemPrompt({ ...INPUT, role: 'routine', routineName: 'Morning brief' })
    expect(prompt).toContain('Your name is Nova')
    expect(prompt).toContain("The user's name is Sam")
    expect(prompt).toContain('No emoji')
    expect(prompt).not.toMatch(/phone|Android/i)
  })

  it('leaves the main prompt without the routine block', () => {
    const prompt = buildSystemPrompt(INPUT)
    expect(prompt).not.toContain('ROUTINE RUN')
  })
})
