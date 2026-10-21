/** LIVE, opt-in (LIVE_COMPOSIO=1 with COMPOSIO_TEST_KEY): the Connect an app search finds apps beyond the popular list. */
import { describe, expect, it } from 'vitest'

import { ConnectBackend } from '../src/main/apps/composio'

const key = process.env['COMPOSIO_TEST_KEY'] ?? ''

describe.skipIf(process.env['LIVE_COMPOSIO'] !== '1' || key === '')('live: Composio search', () => {
  it('finds Fathom', async () => {
    const backend = new ConnectBackend(key)
    let found: unknown
    try {
      found = await backend.searchApps('fathom')
    } catch (error) {
      found = `THREW ${error instanceof Error ? error.message : String(error)}`
    }
    console.log(JSON.stringify(found).slice(0, 600))
    expect(Array.isArray(found) && found.some((app: { slug: string }) => app.slug === 'fathom')).toBe(true)
  }, 60_000)
})
