import { describe, expect, it } from 'vitest'

import { failText, orTell } from '../src/renderer/lib/tell'

describe('orTell: a failed action is told, never swallowed', () => {
  it('gives the value back and says nothing when the work succeeds', async () => {
    const said: string[] = []
    expect(await orTell(Promise.resolve(7), 'It failed.', (line) => said.push(line))).toBe(7)
    expect(said).toEqual([])
  })

  it('tells the error in its own words and resolves to undefined', async () => {
    const said: string[] = []
    expect(await orTell(Promise.reject(new Error('The app is offline.')), 'It failed.', (line) => said.push(line))).toBeUndefined()
    expect(said).toEqual(['The app is offline.'])
  })

  it('falls back when the error has no words', async () => {
    const said: string[] = []
    await orTell(Promise.reject(new Error('')), 'It could not be pinned.', (line) => said.push(line))
    await orTell(Promise.reject(undefined), 'It could not be moved.', (line) => said.push(line))
    expect(said).toEqual(['It could not be pinned.', 'It could not be moved.'])
  })

  it('catches work that throws before it returns a promise', async () => {
    const said: string[] = []
    const result = await orTell<number>(() => {
      throw new Error('No bridge.')
    }, 'It failed.', (line) => said.push(line))
    expect(result).toBeUndefined()
    expect(said).toEqual(['No bridge.'])
  })

  it('failText reads strings and errors', () => {
    expect(failText('Refused.', 'x')).toBe('Refused.')
    expect(failText({ code: 1 }, 'Fallback.')).toBe('Fallback.')
  })
})
