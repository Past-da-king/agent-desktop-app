/** The rail keeps the projects the person chose (at most five); the rest are one tap away in All projects. */
import { describe, expect, it } from 'vitest'

import type { ProjectRow } from '@agent/core'

import { RAIL_PROJECTS, onRail, railHasRoom, railProjects } from '../src/renderer/lib/projects'

let n = 0
function project(name: string, extra: Partial<ProjectRow> = {}): ProjectRow {
  n += 1
  return { id: `p${n}`, createdAt: n, name, description: '', icon: { glyph: 'folder', color: 'iris' }, path: '', profile: '', hidden: false, chats: [], ...extra }
}

describe('the projects rail', () => {
  it('shows the oldest five until the person pins any, never a hidden one', () => {
    const all = [project('A'), project('B', { hidden: true }), project('C'), project('D'), project('E'), project('F'), project('G')]
    expect(railProjects(all).map((p) => p.name)).toEqual(['A', 'C', 'D', 'E', 'F'])
    expect(RAIL_PROJECTS).toBe(5)
  })

  it('shows exactly the pinned ones, in the order they were pinned, at most five', () => {
    const all = [project('A', { railAt: 30 }), project('B'), project('C', { railAt: 10 }), project('D', { railAt: 20 }), project('E', { railAt: 40, hidden: true })]
    expect(railProjects(all).map((p) => p.name)).toEqual(['C', 'D', 'A'])
    expect(onRail(all[4]!)).toBe(false)
    const six = Array.from({ length: 6 }, (_, i) => project(`P${i}`, { railAt: i }))
    expect(railProjects(six)).toHaveLength(5)
    expect(railHasRoom(six)).toBe(false)
    expect(railHasRoom(all)).toBe(true)
  })
})
