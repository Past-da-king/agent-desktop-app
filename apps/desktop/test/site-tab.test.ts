/**
 * Learned apps keep one tab per site (23 Oct 2026): two WhatsApp Web tabs in the agent browser kept kicking each
 * other off with "Use here".
 */
import { describe, expect, it } from 'vitest'

import type { LearnedApp } from '../src/main/apps/store'
import { onSite, siteHost, siteTabPlan } from '../src/main/browser/site-tab'
import type { BrowserDriver } from '../src/main/browser/types'
import { browserRunner } from '../src/main/tools/webapps'

const P = 'persist:agent-browser'
const WA = 'https://web.whatsapp.com'

describe('one tab per site', () => {
  it('keeps one WhatsApp tab and closes the duplicates in the same partition only', () => {
    const tabs = [
      { id: 't1', partition: P, url: 'https://web.whatsapp.com/' },
      { id: 't2', partition: P, url: 'https://example.org/' },
      { id: 't3', partition: P, url: 'https://web.whatsapp.com/' },
      { id: 't4', partition: 'persist:profile-x', url: 'https://web.whatsapp.com/' },
    ]
    expect(siteTabPlan(tabs, WA, P, null, null)).toEqual({ keep: 't1', close: ['t3'] })
    // The acting agent's own tab on the site is the one kept.
    expect(siteTabPlan(tabs, WA, P, 't3', null)).toEqual({ keep: 't3', close: ['t1'] })
    // The person's tab is kept and never closed.
    expect(siteTabPlan(tabs, WA, P, 't1', 't3')).toEqual({ keep: 't3', close: ['t1'] })
    // Another profile's browser is left alone.
    expect(siteTabPlan(tabs, WA, 'persist:profile-x', null, null)).toEqual({ keep: 't4', close: [] })
    // No tab on the site: nothing to reuse.
    expect(siteTabPlan(tabs, 'https://www.reddit.com', P, null, null)).toBeNull()
  })

  it('matches the site and its subdomains, never a look-alike', () => {
    expect(siteHost('https://www.reddit.com/r/x')).toBe('reddit.com')
    expect(onSite('https://old.reddit.com/', 'reddit.com')).toBe(true)
    expect(onSite('https://notreddit.com/', 'reddit.com')).toBe(false)
    expect(onSite('about:blank', 'reddit.com')).toBe(false)
  })

  it('a learned tool reuses the tab already on the site instead of opening another', async () => {
    const opened: string[] = []
    let reuse = true
    const browser = {
      open: async (url: string) => {
        opened.push(url)
        return ''
      },
      currentUrl: () => 'https://example.org/',
      useSiteTab: () => reuse,
    } as unknown as BrowserDriver
    const app = { id: 'whatsapp', name: 'WhatsApp', startUrl: WA, about: '', tools: [], trusted: false, updatedAt: 0 } as LearnedApp
    await browserRunner(browser).ensure(app)
    expect(opened).toEqual([])
    reuse = false
    await browserRunner(browser).ensure(app)
    expect(opened).toEqual([WA])
  })
})
