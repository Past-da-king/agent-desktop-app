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

  it("drops a saved user agent that only repeats this computer's own Chrome, so a stale version never ships", () => {
    const dir = mkdtempSync(join(tmpdir(), 'sites-ua-'))
    const file = join(dir, 'sites.json')
    const token = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64'
    const stale = `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36`
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
    writeFileSync(file, JSON.stringify({
      version: 1,
      defaultView: { ...presetView('desktop'), userAgent: stale },
      sites: { 'a.example': { at: 1, view: { ...presetView('phone'), userAgent: android }, outcome: 'works', pinned: true } },
    }))
    const store = new SiteStore(file)
    expect(store.defaultView().userAgent).toBe('')
    // A user agent that names another device is a real choice and stays (its version is corrected when it is used).
    expect(store.viewFor('https://a.example/').userAgent).toBe(android)
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

  it('one time, forgets phone views the old rule recorded by itself and keeps ones set by hand', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sites-mig-'))
    const file = join(dir, 'browser-sites.json')
    writeFileSync(file, JSON.stringify({
      version: 1,
      defaultView: presetView('desktop'),
      sites: {
        'auto.example': { at: 1, view: presetView('phone'), outcome: 'works', reason: 'as a desktop browser: the page loaded empty' },
        'auto-fixed.example': { at: 1, view: presetView('phone'), outcome: 'works', css: ['.x{display:none}'] },
        'hand.example': { at: 1, view: presetView('phone'), outcome: 'works', pinned: true, reason: 'chosen by hand' },
        'desk.example': { at: 1, view: presetView('desktop'), outcome: 'works' },
      },
    }))
    const store = new SiteStore(file)
    expect(store.get('https://auto.example/')).toBeNull()
    expect(store.get('https://auto-fixed.example/')?.view).toBeUndefined()
    expect(store.get('https://auto-fixed.example/')?.css).toEqual(['.x{display:none}'])
    expect(store.get('https://hand.example/')?.view?.mode).toBe('phone')
    expect(store.get('https://desk.example/')?.view?.mode).toBe('desktop')
    // Runs once: a phone view recorded afterwards (a real refusal that a phone fixed) survives a reload.
    store.record('https://later.example/', presetView('phone'), 'works', 'as a desktop browser: unsupported')
    expect(new SiteStore(file).get('https://later.example/')?.view?.mode).toBe('phone')
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
    expect(assessPage(200, null, '', 'Please use a supported browser to open this page.').refusal).toBe('unsupported_browser')
    expect(assessPage(null, 'net::ERR_NAME_NOT_RESOLVED', '', '').refusal).toBe('load_error')
  })

  it('does not call an app shell blank: a real title or a visible frame is content', () => {
    // Doc.aspx style: no top-level text, the editor lives in an iframe.
    expect(assessPage(200, null, 'Deck.pptx', '').refusal).toBe('none')
    expect(assessPage(200, null, '', '', 1).refusal).toBe('none')
    expect(assessPage(200, null, ' ', '', 0).refusal).toBe('blank')
    expect(assessPage(200, null, '', '').refusal).toBe('blank')
  })

  it('treats a long page that mentions supported browsers in its footer as fine', () => {
    const page = `${LONG.repeat(20)} Supported browsers: use a modern browser for the best experience.`
    expect(assessPage(200, null, 'Home', page).refusal).toBe('none')
  })
})

describe('opening a site the way that works', () => {
  it('tries the other device when refused, remembers the winner and starts there next time', async () => {
    const store = new SiteStore(null)
    const blankOnDesktop = fakeSite((view) => (view.mode === 'desktop' ? 'This browser is not supported. Please use a supported browser.' : null))
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

  it('tries a phone once for a captcha wall, stores nothing when it does not help, and says what to do', async () => {
    const store = new SiteStore(null)
    const site = fakeSite(() => 'Verify you are human')
    const opened = await openAdaptive(site, store, 'https://guarded.example/', null)
    expect(opened.verdict.refusal).toBe('human_check')
    expect(site.loads).toEqual(['desktop', 'phone', 'desktop'])
    expect(opened.notes).toContain('browser_handoff')
    expect(store.get('https://guarded.example')?.view?.mode).toBe('desktop')
  })

  it('does not retry as a phone on an iframe app shell, and stores it as working on desktop', async () => {
    const store = new SiteStore(null)
    const loads: string[] = []
    let view = presetView('desktop')
    const port: SitePort = {
      currentView: () => view,
      applyView: async (next) => {
        view = { ...next }
      },
      load: async () => {
        loads.push(view.mode)
        return { status: 200, error: null, title: 'Deck.pptx', text: '', frames: 1 }
      },
    }
    const opened = await openAdaptive(port, store, 'https://tenant.sharepoint.example/Doc.aspx?x=1', null)
    expect(loads).toEqual(['desktop'])
    expect(opened.triedBoth).toBe(false)
    expect(opened.view.mode).toBe('desktop')
    expect(store.get('https://tenant.sharepoint.example/')?.view?.mode).toBe('desktop')
  })

  it('does not store a retry that fails to beat the first load, and reloads on the start view', async () => {
    const store = new SiteStore(null)
    const site = fakeSite(() => 'Access denied')
    const opened = await openAdaptive(site, store, 'https://both.example/', null)
    expect(opened.verdict.refusal).toBe('http_blocked')
    expect(site.loads).toEqual(['desktop', 'phone', 'desktop'])
    expect(site.currentView().mode).toBe('desktop')
    const profile = store.get('https://both.example/')
    expect(profile?.view?.mode).toBe('desktop')
    expect(profile?.outcome).toBe('refused')
  })

  it('respects a view the agent asked for and does not second-guess it', async () => {
    const store = new SiteStore(null)
    const site = fakeSite(() => '')
    const opened = await openAdaptive(site, store, 'https://asked.example/', presetView('tablet'))
    expect(site.loads).toEqual(['tablet'])
    expect(opened.triedBoth).toBe(false)
  })
})
