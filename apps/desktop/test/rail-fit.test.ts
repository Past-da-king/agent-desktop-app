/**
 * A short window never squashes the rail's navigation: the projects take only the room left, at full size, then
 * smaller, then fewer, with the All tile always there and counting the rest. Same rule collapsed and expanded.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { RAIL_PAD, RAIL_PAD_SMALL, RAIL_TILE, RAIL_TILE_SMALL, fitRail } from '../src/renderer/lib/projects'

// Collapsed: one column and no name. Expanded: three columns with the name and its gap (about 20) under each tile.
const collapsed = (room: number) => ({ room, cols: 1, gap: 6, extra: 0 })
const expanded = (room: number) => ({ room, cols: 3, gap: 6, extra: 20 })
const rowFull = RAIL_PAD + RAIL_TILE + 6
const rowSmall = RAIL_PAD_SMALL + RAIL_TILE_SMALL + 6

describe('fitting projects in the room the rail has left', () => {
  it('shows every project and the All tile at full size when they fit', () => {
    expect(fitRail(collapsed(6 * rowFull), 5)).toEqual({ small: false, show: 5, none: false })
    expect(fitRail(expanded(2 * (20 + RAIL_PAD + RAIL_TILE + 6)), 5)).toEqual({ small: false, show: 5, none: false })
  })

  it('makes the tiles smaller before it drops any project', () => {
    // Too little for six full rows, enough for six small ones.
    expect(fitRail(collapsed(6 * rowSmall), 5)).toEqual({ small: true, show: 5, none: false })
  })

  it('then shows fewer projects, leaving the last place to the All tile', () => {
    expect(fitRail(collapsed(3 * rowSmall), 5)).toEqual({ small: true, show: 2, none: false })
    expect(fitRail(expanded(20 + RAIL_PAD_SMALL + RAIL_TILE_SMALL + 6), 5)).toEqual({ small: true, show: 2, none: false })
  })

  it('keeps the All tile when only one tile fits', () => {
    expect(fitRail(collapsed(rowSmall), 5)).toEqual({ small: true, show: 0, none: false })
  })

  it('says when not even the All tile fits, so the expanded rail leaves it to its header link', () => {
    expect(fitRail(collapsed(0), 5)).toEqual({ small: true, show: 0, none: true })
    expect(fitRail(expanded(30), 5)).toEqual({ small: true, show: 0, none: true })
  })

  it('never shows more projects than there are', () => {
    expect(fitRail(collapsed(5000), 2)).toEqual({ small: false, show: 2, none: false })
    expect(fitRail(collapsed(5000), 0)).toEqual({ small: false, show: 0, none: false })
  })

  it('more room never shows fewer projects', () => {
    let last = -1
    for (let room = 0; room < 800; room += 7) {
      const fit = fitRail(collapsed(room), 5)
      expect(fit.show).toBeGreaterThanOrEqual(last)
      last = fit.show
    }
  })
})

describe('the rail layout', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles/projects.css'), 'utf8')
  const rail = fs.readFileSync(path.join(__dirname, '../src/renderer/shell/Rail.tsx'), 'utf8')

  it('never lets the navigation shrink; only the projects area gives up room', () => {
    expect(css).toMatch(/\.rail > \*\{flex-shrink:0\}/)
    expect(css).toMatch(/\.rail > \.pj-rail\{flex:1 1 0;overflow:hidden/)
  })

  it('fits the projects to the measured room instead of drawing them all', () => {
    expect(rail).toMatch(/fitRail\(room, pinned\.length\)/)
    expect(rail).not.toMatch(/className="spacer"/)
  })
})
