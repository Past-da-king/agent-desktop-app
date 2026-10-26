/**
 * The guide's ring and label wear the app's own look (26 Oct 2026, 0.2.86): the colour comes from the accent and
 * theme he chose in Settings, never a colour of the overlay's own (it was a hard-coded orange).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { guideRestyleScript, guideShowScript, guideStyle } from '../src/main/browser/guide-page'
import { ACCENTS, brandLook, IRIS, withAlpha } from '../src/shared/brand'

const show = (look?: ReturnType<typeof brandLook>): string =>
  guideShowScript({ token: 't', query: { name: 'Go' }, mode: 'exact', pick: 0, label: 'Click Go', step: 1, total: 2, ...(look === undefined ? {} : { look }) })

describe('guide overlay brand', () => {
  it('takes its colour from the accent and theme he chose', () => {
    const ocean = ACCENTS.find((a) => a.id === 'ocean')!
    const rose = ACCENTS.find((a) => a.id === 'rose')!
    const oceanLight = show(brandLook({ theme: 'light', accent: 'ocean' }))
    const roseDark = show(brandLook({ theme: 'dark', accent: 'rose' }))
    expect(oceanLight).toContain(`border:3px solid ${ocean.light![0]}`)
    expect(oceanLight).toContain(`button.ok{background:${ocean.light![0]};color:${ocean.light![1]}}`)
    expect(oceanLight).toContain(withAlpha(ocean.light![0], 0.5))
    expect(roseDark).toContain(`border:3px solid ${rose.dark![0]}`)
    expect(roseDark).not.toContain(ocean.light![0])
    // No accent chosen (or one the app does not know): the app's default, iris; system theme follows the computer.
    expect(show()).toContain(`border:3px solid ${IRIS.light[0]}`)
    expect(show(brandLook({ theme: 'system', accent: 'nope', systemDark: true }))).toContain(`border:3px solid ${IRIS.dark[0]}`)
    // A change while a ring shows restyles it with the new accent.
    expect(guideRestyleScript(brandLook({ accent: 'teal' }))).toContain(ACCENTS.find((a) => a.id === 'teal')!.light![0])
  })

  it('has no colour of its own left (no orange, no hex in the page script)', () => {
    const src = readFileSync(join(__dirname, '../src/main/browser/guide-page.ts'), 'utf8')
    expect(src).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(src).not.toMatch(/255,\s*90,\s*31/)
    for (const accent of ACCENTS) expect(guideStyle(brandLook({ accent: accent.id }))).not.toMatch(/ff5a1f|255,90,31/i)
  })

  it('matches the renderer tokens (one source)', () => {
    const css = readFileSync(join(__dirname, '../src/renderer/styles/tokens.css'), 'utf8')
    const block = (start: string): string => css.slice(css.indexOf(start), css.indexOf('}', css.indexOf(start)))
    const light = block(':root{')
    const dark = block(':root[data-theme="dark"]{')
    const tokens = ['--primary', '--on-primary', '--pc', '--on-pc']
    tokens.forEach((t, i) => {
      expect(light).toContain(`${t}:${IRIS.light[i]}`)
      expect(dark).toContain(`${t}:${IRIS.dark[i]}`)
    })
    expect(light).toContain(`--s-lowest:${brandLook({ theme: 'light' }).surface}`)
    expect(dark).toContain(`--s-high:${brandLook({ theme: 'dark' }).surface}`)
  })
})
