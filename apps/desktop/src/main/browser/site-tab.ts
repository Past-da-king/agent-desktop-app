/**
 * Learned apps: one tab per site. Some sites allow one live session per browser (WhatsApp Web shows "Use here"
 * and drops the other tab), so when two agents each opened their own tab on the site they kept kicking each other
 * off. An agent running a learned app therefore drives the tab already on the site in its own partition, and any
 * other tab on that site in the partition is closed.
 */

/** What the choice needs to know about a tab. */
export interface SiteTabInfo {
  id: string
  partition: string
  url: string
}

export interface SiteTabPlan {
  /** The tab the agent drives from now on. */
  keep: string
  /** Other tabs on the same site in the same partition, to close. */
  close: string[]
}

/** The site's host without "www.", lower case; '' when the address has none. */
export function siteHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www[.]/, '')
  } catch {
    return ''
  }
}

/** Is the page on this site (the host itself or one of its subdomains)? */
export function onSite(pageUrl: string, host: string): boolean {
  const page = siteHost(pageUrl)
  return host !== '' && page !== '' && (page === host || page.endsWith(`.${host}`))
}

/**
 * Which tab to keep for a site, and which duplicates to close. Kept, in order: the person's own tab on the site
 * (it is never closed), the acting agent's tab, the first one. Null when no tab in the partition is on the site.
 */
export function siteTabPlan(tabs: SiteTabInfo[], url: string, partition: string, mine: string | null, personTab: string | null): SiteTabPlan | null {
  const host = siteHost(url)
  const there = tabs.filter((tab) => tab.partition === partition && onSite(tab.url, host))
  if (there.length === 0) return null
  const keep = there.find((tab) => tab.id === personTab) ?? there.find((tab) => tab.id === mine) ?? there[0]!
  return { keep: keep.id, close: there.filter((tab) => tab.id !== keep.id && tab.id !== personTab).map((tab) => tab.id) }
}
