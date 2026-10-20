import { describe, expect, it } from 'vitest'

import type { MemoryRow } from '@agent/core'

import { rank, terms } from '../src/main/runtime/recall'

function memory(partial: Partial<MemoryRow> & { title: string }): MemoryRow {
  return {
    id: partial.id ?? partial.title.toLowerCase(),
    body: '',
    kind: 'fact',
    topics: '',
    pinned: false,
    source: 'agent',
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  }
}

describe('recall terms', () => {
  it('drops the words that match everything', () => {
    expect([...terms('What is the address for my plumber')]).toEqual(['address', 'plumber'])
  })

  it('keeps names, numbers and email-like words', () => {
    expect([...terms('Lerato 2026 ap@example.com')]).toEqual(['lerato', '2026', 'ap@example.com'])
  })
})

describe('recall rank', () => {
  it('puts a title hit above a body hit', () => {
    const rows = [
      memory({ title: 'Weekend plans', body: 'A trip to Durban with Lerato.' }),
      memory({ title: 'Durban', body: 'A city by the sea.' }),
    ]
    const ranked = rank('durban', rows, 5)
    expect(ranked[0]?.title).toBe('Durban')
  })

  it('counts topics above the body', () => {
    const rows = [
      memory({ title: 'Trip', body: 'We drive down on Friday.' }),
      memory({ title: 'Trip', topics: 'durban, summer', body: 'We drive down on Friday.' }),
    ]
    const ranked = rank('durban', rows, 5)
    expect(ranked[0]).toBe(rows[1])
    expect(ranked).toHaveLength(1)
  })

  it('leaves out anything with no real overlap', () => {
    const rows = [memory({ title: 'Lerato', body: 'Lives in Durban.' }), memory({ title: 'Bakery' })]
    expect(rank('durban', rows, 5).map((row) => row.title)).toEqual(['Lerato'])
  })

  it('prefers a pinned page when the overlap is equal', () => {
    const rows = [
      memory({ id: 'plain', title: 'Lerato', body: 'Lives in Durban.' }),
      memory({ id: 'pinned', title: 'Lerato', body: 'Lives in Durban.', pinned: true }),
    ]
    expect(rank('durban', rows, 1)[0]?.id).toBe('pinned')
  })

  it('returns the newest pages first when there is nothing to search for', () => {
    const rows = [
      memory({ id: 'old', title: 'Old', updatedAt: 1_000 }),
      memory({ id: 'new', title: 'New', updatedAt: 9_000 }),
    ]
    expect(rank('the a of', rows, 2).map((row) => row.id)).toEqual(['new', 'old'])
  })

  it('never returns more than the limit', () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      memory({ id: String(index), title: 'Durban', updatedAt: index }),
    )
    expect(rank('durban', rows, 3)).toHaveLength(3)
  })
})
