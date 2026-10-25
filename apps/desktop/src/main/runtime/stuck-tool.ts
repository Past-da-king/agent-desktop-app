/**
 * Which tool a quiet helper is stuck in (25 Oct 2026). The quiet heads-up used to say only "no new step for 10 min";
 * a helper sat in browser_wait_for on a hidden page and its creator had to dig to find out. Now the heads-up names
 * the tool it is in right now, for how long, and the site when it is a browser tool. Pure, so it is tested alone.
 */

/** The tool a run is in right now. */
export interface ToolInFlight {
  id: string
  name: string
  since: number
}

const MINUTE_MS = 60_000

/** The site a browser tool is on: from its own input (browser_open's url) or the last page it reported. */
export function siteOf(raw: string): string {
  const text = raw.trim()
  if (text === '') return ''
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** The page a browser tool's answer was on: its "URL: ..." line, or ''. */
export function urlFromResult(result: string): string {
  const line = /^URL: (\S+)/m.exec(result)
  return line?.[1] ?? ''
}

/** The site a starting tool call names itself (browser_open's url), or ''. */
export function siteFromCall(name: string, input: Record<string, unknown>): string {
  if (!name.startsWith('browser_')) return ''
  const url = input['url']
  return typeof url === 'string' ? siteOf(url) : ''
}

/** ", stuck in browser_wait_for on youtube.com for 9 min" (empty when it is in no tool). */
export function stuckPhrase(tool: { name: string; since: number } | null | undefined, now: number, site = ''): string {
  if (tool === null || tool === undefined || tool.name === '') return ''
  const minutes = Math.max(1, Math.round((now - tool.since) / MINUTE_MS))
  const where = site !== '' && tool.name.startsWith('browser_') ? ` on ${site}` : ''
  return `, stuck in ${tool.name}${where} for ${minutes} min`
}
