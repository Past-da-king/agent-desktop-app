import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('every full page scrolls', () => {
  it('the sheet scrolls unless the page owns its scroll, and the panel does not stop it', () => {
    const shell = read('../src/renderer/shell/Shell.tsx')
    expect(shell).not.toMatch(/panel\s*\?\s*\{\s*overflow:\s*'hidden'/)
    expect(shell).toContain("ownScroll ? 'sheet own-scroll' : 'sheet'")
    const css = read('../src/renderer/styles/shell.css')
    const sheet = /(?:^|\n)\.sheet\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(sheet).toContain('overflow:auto')
    expect(sheet).toContain('min-height:0')
    expect(css).toMatch(/\.sheet\.own-scroll\{overflow:hidden\}/)
  })

  it('the height chain from window to sheet is bounded', () => {
    const css = read('../src/renderer/styles/shell.css')
    expect(/\.stage\{([^}]*)\}/.exec(css)?.[1]).toContain('grid-template-rows:minmax(0,1fr)')
    expect(/(?:^|\n)\.shell\{([^}]*)\}/.exec(css)?.[1]).toContain('grid-template-rows:minmax(0,1fr)')
  })

  it('only Chat keeps the sheet still; the project page keeps its panel and scrolls', () => {
    const app = read('../src/renderer/App.tsx')
    const owners = app.match(/ownScroll>\s*<(\w+)/g) ?? []
    expect(owners.map((m) => /<(\w+)$/.exec(m)?.[1])).toEqual(['Chat'])
    expect(app).toMatch(/<Shell panel=\{<ChatPanel \/>\}>\s*<Project /)
  })
})
