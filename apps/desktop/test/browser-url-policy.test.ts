import { describe, expect, it } from 'vitest'

import { checkBrowserUrl, privateHostReason } from '../src/main/browser/url-policy'

describe('browser url policy', () => {
  it('allows normal web addresses and adds https to a bare domain', () => {
    expect(checkBrowserUrl('https://example.com/flights?q=1')).toEqual({
      ok: true,
      url: 'https://example.com/flights?q=1',
    })
    expect(checkBrowserUrl('example.com')).toEqual({ ok: true, url: 'https://example.com/' })
    expect(checkBrowserUrl('http://example.com')).toEqual({ ok: true, url: 'http://example.com/' })
  })

  it('trims spaces and rejects an empty address', () => {
    expect(checkBrowserUrl('  example.com  ')).toEqual({ ok: true, url: 'https://example.com/' })
    expect(checkBrowserUrl('   ')).toEqual({ ok: false, reason: 'Pass a web address.' })
  })

  it('blocks local files and browser internals', () => {
    for (const url of [
      'file:///etc/passwd',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'javascript:alert(1)',
      'data:text/html,hello',
      'about:blank',
    ]) {
      const result = checkBrowserUrl(url)
      expect(result.ok, url).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/web addresses|valid/)
    }
  })

  it('blocks a username or password built into the address', () => {
    const result = checkBrowserUrl('https://user:secret@example.com/')
    expect(result.ok).toBe(false)
  })

  it('blocks this computer and private networks for the agent', () => {
    for (const url of [
      'http://localhost:3000',
      'http://127.0.0.1/',
      'http://10.0.0.5/',
      'http://172.20.1.1/',
      'http://192.168.1.1/',
      'http://169.254.0.1/',
      'http://[::1]/',
      'http://router.local/',
      'http://printer.internal/',
      'http://myserver/',
    ]) {
      const result = checkBrowserUrl(url)
      expect(result.ok, url).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/Only you can open/)
    }
  })

  it('lets a person open a private address themselves', () => {
    expect(checkBrowserUrl('http://127.0.0.1:8080/', { personTyped: true })).toEqual({
      ok: true,
      url: 'http://127.0.0.1:8080/',
    })
    expect(checkBrowserUrl('http://localhost:3000/', { personTyped: true })).toEqual({
      ok: true,
      url: 'http://localhost:3000/',
    })
  })

  it('still blocks dangerous schemes when a person typed the address', () => {
    expect(checkBrowserUrl('file:///tmp/a.html', { personTyped: true }).ok).toBe(false)
    expect(checkBrowserUrl('chrome://settings', { personTyped: true }).ok).toBe(false)
  })

  it('blocks a local machine name for the agent but not for the person', () => {
    expect(checkBrowserUrl('http://myserver/').ok).toBe(false)
    expect(checkBrowserUrl('http://myserver/', { personTyped: true }).ok).toBe(true)
  })

  it('classifies public addresses as safe', () => {
    expect(privateHostReason('example.com')).toBeNull()
    expect(privateHostReason('8.8.8.8')).toBeNull()
    expect(privateHostReason('2001:4860:4860::8888')).toBeNull()
  })

  it('recognises mapped IPv6 loopback and private addresses', () => {
    expect(checkBrowserUrl('http://[::ffff:127.0.0.1]/').ok).toBe(false)
    expect(checkBrowserUrl('http://[::ffff:192.168.0.2]/').ok).toBe(false)
  })
})
