import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** A voice note plays from a blob: URL made from the bytes the window fetched; the page's policy must let media load from it. */
describe('renderer content security policy', () => {
  const html = readFileSync(join(__dirname, '../src/renderer/index.html'), 'utf8')
  const policy = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? ''
  const directive = (name: string): string[] =>
    (policy.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === name) ?? policy.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === 'default-src') ?? []).slice(1)

  it('lets audio load from blob: URLs (voice notes)', () => {
    expect(directive('media-src')).toContain('blob:')
  })

  it('stays closed to remote media and scripts', () => {
    expect(directive('media-src')).not.toContain('https:')
    expect(directive('script-src')).toEqual(["'self'"])
  })
})
