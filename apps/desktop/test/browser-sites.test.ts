import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { presetView, type ViewSpec } from '../src/main/browser/emulation'
import { assessPage, openAdaptive, siteOf, SiteStore, type SitePort } from '../src/main/browser/sites'

const LONG = 'A perfectly ordinary page with plenty of readable text on it for the health check.'

/** A fake site that refuses some kinds of browser. */
function fakeSite(refuse: (view: ViewSpec) => string | null): SitePort & { loads: string[] } {
  let view = presetView('desktop')
  const loads: string[] = []
  return {
    loads,
    currentView: () => view,
    applyView: async (next) => {
      view = { ...next }
    },
    load: async () => {
      loads.push(view.mode)
      const refusal = refuse(view)
      return refusal === null
        ? { status: 200, error: null, title: 'Fine', text: LONG }
        : { status: 200, error: null, title: 'Sorry', text: refusal }
    },
  }
}

describe('site profiles', () => {
  it('keys sites by host without www. or m., and only for web addresses', () => {
    expect(siteOf('https://www.example.com/a')).toBe('example.com')
    expect(siteOf('m.example.com')).toBe('example.com')
    expect(siteOf('https://mail.example.com')).toBe('mail.example.com')
    expect(siteOf('file:///etc/passwd')).toBeNull()
  })

  it('keeps views, fixes and headers in a JSON file and reads them back', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sites-')), 'browser-sites.json')
    const store = new SiteStore(file, () => 42)
    store.record('https://shop.example/x', presetView('phone'), 'works')
    store.addCss('https://shop.example', '.cookie{display:none}')
    store.addCss('https://shop.example', '.cookie{display:none}')
    store.setHeaders('https://shop.example', { 'X-Test': 'yes' })
    store.setDefaultView(presetView('tablet'))
    expect(JSON.parse(readFileSync(file, 'utf8')).sites['shop.example'].css).toHaveLength(1)

    const again = new SiteStore(file)
    expect(again.viewFor('https://shop.example/other').mode).toBe('phone')
    expect(again.viewFor('https://unknown.example').mode).toBe('tablet')
    expect(again.headersFor('https://shop.example/api')).toEqual({ 'X-Test': 'yes' })
    expect(again.forget('https://shop.example')).toBe(true)
    expect(again.get('https://shop.example')).toBeNull()
  })

  it('starts fresh from a damaged file instead of refusing to browse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sites-'))
    const file = join(dir, 'browser-sites.json')
    writeFileSync(file, '{not json')
    const store = new SiteStore(file)
    expect(store.defaultView().mode).toBe('desktop')
  })
})

describe('reading a page for a refusal', () => {
  it('spots an unsupported browser, a block, a human check, a refused sign-in and a blank page', () => {
    expect(assessPage(200, null, '', 'Use WhatsApp Web from a browser on your computer').refusal).toBe('unsupported_browser')
    expect(assessPage(403, null, 'Forbidden', 'Access denied').refusal).toBe('http_blocked')
    expect(assessPage(200, null, 'Just a moment...', 'Checking your browser before accessing').refusal).toBe('human_check')
    expect(assessPage(200, null, '', "Couldn't sign you in. This browser or app may not be secure.").refusal).toBe('signin_refused')
    expect(assessPage(200, null, '', '').refusal).toBe('blank')
    expect(assessPage(null, 'net::ERR_NAME_NOT_RESOLVED', '', '').refusal).toBe('load_error')
  })

  it('treats a long page that mentions supported browsers in its footer as fine', () => {
    const page = `${LONG.repeat(20)} Supported browsers: use a modern browser for the best experience.`
    expect(assessPage(200, null, 'Home', page).refusal).toBe('none')
  })
})

describe('opening a site the way that works', () => {
  it('tries the other device when refused, remembers the winner and starts there next time', async () => {
    const store = new SiteStore(null)
    const blankOnDesktop = fakeSite((view) => (view.mode === 'desktop' ? '' : null))
    const first = await openAdaptive(blankOnDesktop, store, 'https://app.example/', null)
    expect(first.verdict.refusal).toBe('none')
    expect(first.view.mode).toBe('phone')
    expect(first.triedBoth).toBe(true)
    expect(first.notes).toContain('Remembered')
    expect(blankOnDesktop.loads).toEqual(['desktop', 'phone'])

    const second = await openAdaptive(blankOnDesktop, store, 'https://app.example/next', null)
    expect(second.view.mode).toBe('phone')
    expect(blankOnDesktop.loads).toEqual(['desktop', 'phone', 'phone'])
    expect(second.notes).toContain('Known site')
  })

  it('does not flip devices for a captcha, and says what to do', async () => {
    const store = new SiteStore(null)
    const site = fakeSite(() => 'Verify you are human')
    const opened = await openAdaptive(site, store, 'https://guarded.example/', null)
    expect(opened.verdict.refusal).toBe('human_check')
    expect(site.loads).toEqual(['desktop'])
    expect(opened.notes).toContain('browser_handoff')
  })

  it('goes back to where it started when both devices are refused', async () => {
    const store = new SiteStore(null)
    const site = fakeSite(() => '')
    const opened = await openAdaptive(site, store, 'https://dead.example/', null)
    expect(opened.triedBoth).toBe(true)
    expect(opened.view.mode).toBe('desktop')
    expect(site.currentView().mode).toBe('desktop')
    expect(store.get('https://dead.example')?.outcome).toBe('refused')
    expect(opened.notes).toContain('THE SITE REFUSED THIS BROWSER')
  })

  it('respects a view the agent asked for and does not second-guess it', async () => {
    const store = new SiteStore(null)
    const site = fakeSite(() => '')
    const opened = await openAdaptive(site, store, 'https://asked.example/', presetView('tablet'))
    expect(site.loads).toEqual(['tablet'])
    expect(opened.triedBoth).toBe(false)
  })
})
