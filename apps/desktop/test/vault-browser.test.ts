/**
 * The Vault in the browser (vault/browser-vault.ts) through a fake page debugger: suggestions and fill only for the
 * page's own site and only for the person, save and update offers, "Don't ask me", passkeys made and used through the
 * WebAuthn domain only after a yes. Plus the ask settings for agents (reveal, passkey).
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { hostMatches, registrableDomain, type Tool } from '@agent/core'

import { FileKeyCipher } from '../src/headless/file-cipher'
import { Secrets } from '../src/main/secrets'
import { vaultTools } from '../src/main/tools/vault'
import { BrowserVault, generatePassword, type VaultLink } from '../src/main/vault/browser-vault'
import { guardTools } from '../src/main/vault/guard'
import { VAULT_BINDING } from '../src/main/vault/page-scripts'
import { VaultStore } from '../src/main/vault/store'
import { testContext, toolNamed } from './support'

const PASSWORD = 'pw-' + randomBytes(8).toString('hex')
let dir = ''
let vault: VaultStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-vaultb-'))
  vault = new VaultStore(new Secrets(join(dir, 'secrets'), new FileKeyCipher(join(dir, 'secrets.key'))))
  vault.save({ name: 'Example', kind: 'login', username: 'me@example.com', url: 'https://login.example.com/', fields: { password: PASSWORD } })
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A page debugger: records commands, answers WebAuthn, and lets the test call the vault binding. */
class FakePage implements VaultLink {
  readonly sent: Array<{ method: string; params: Record<string, unknown> }> = []
  readonly replies = new Map<number, unknown>()
  readonly pushes: unknown[] = []
  private listener: ((method: string, params: Record<string, unknown>, sessionId?: string) => void) | null = null
  authenticatorCreds: Array<Record<string, unknown>> = []
  private seq = 0

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.sent.push({ method, params })
    if (method === 'Runtime.evaluate') {
      const expr = String(params['expression'] ?? '')
      const reply = /__agentVaultReply\((\d+), ([\s\S]*)\)$/.exec(expr)
      if (reply !== null) this.replies.set(Number(reply[1]), JSON.parse(reply[2]!))
      const push = /__agentVaultPush\(([\s\S]*)\)$/.exec(expr)
      if (push !== null) this.pushes.push(JSON.parse(JSON.parse(push[1]!) as string))
    }
    if (method === 'WebAuthn.addVirtualAuthenticator') return { authenticatorId: 'auth-1' }
    if (method === 'WebAuthn.addCredential') this.authenticatorCreds.push(params['credential'] as Record<string, unknown>)
    if (method === 'WebAuthn.getCredentials') return { credentials: this.authenticatorCreds }
    return {}
  }

  onEvent(listener: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void {
    this.listener = listener
    return () => (this.listener = null)
  }

  /** The page's vault world calls the binding; resolves with the reply. */
  async call(op: string, data: Record<string, unknown>, href = 'https://login.example.com/signin'): Promise<Record<string, unknown>> {
    const id = ++this.seq
    this.listener?.('Runtime.bindingCalled', { name: VAULT_BINDING, payload: JSON.stringify({ id, op, href, top: true, ...data }), executionContextId: 7 })
    for (let i = 0; i < 200 && !this.replies.has(id); i++) await new Promise((r) => setTimeout(r, 5))
    return (this.replies.get(id) ?? {}) as Record<string, unknown>
  }
}

async function attach(person: boolean): Promise<{ page: FakePage; bv: BrowserVault }> {
  const bv = new BrowserVault(vault)
  const page = new FakePage()
  await bv.attach(page, { person: () => person })
  return { page, bv }
}

describe('site matching', () => {
  it('matches the registrable domain', () => {
    expect(registrableDomain('login.example.co.uk')).toBe('example.co.uk')
    expect(registrableDomain('a.b.example.com')).toBe('example.com')
    expect(hostMatches(['login.example.com'], 'www.example.com')).toBe(true)
    expect(hostMatches(['login.example.com'], 'example.com.evil.net')).toBe(false)
  })

  it('makes strong passwords', () => {
    const p = generatePassword()
    expect(p).toHaveLength(20)
    expect(p).toMatch(/[a-z]/)
    expect(p).toMatch(/[A-Z]/)
    expect(p).toMatch(/[0-9]/)
    expect(generatePassword()).not.toBe(p)
  })
})

describe('autofill', () => {
  it('injects its scripts and binding into the page', async () => {
    const { page } = await attach(true)
    const methods = page.sent.map((s) => s.method)
    expect(methods).toContain('Runtime.addBinding')
    expect(page.sent.filter((s) => s.method === 'Page.addScriptToEvaluateOnNewDocument')).toHaveLength(2)
  })

  it('suggests and fills only this site, only for the person, without the value in the suggestion', async () => {
    const { page } = await attach(true)
    const suggest = await page.call('suggest', { field: 'username' })
    expect(JSON.stringify(suggest)).toContain('me@example.com')
    expect(JSON.stringify(suggest)).not.toContain(PASSWORD)
    const key = (suggest['rows'] as Array<Record<string, string>>)[0]!['key']!
    expect(await page.call('fill', { key })).toMatchObject({ ok: true, username: 'me@example.com', password: PASSWORD })
    expect(await page.call('fill', { key }, 'https://example.com.evil.net/')).toMatchObject({ ok: false })
    expect((await page.call('suggest', { field: 'password' }, 'https://other.org/')).rows).toEqual([])
    const agent = await attach(false)
    expect((await agent.page.call('suggest', { field: 'username' })).rows).toEqual([])
    expect(await agent.page.call('fill', { key })).toMatchObject({ ok: false })
  })

  it('offers a strong password on a new-password field', async () => {
    const { page } = await attach(true)
    const rows = (await page.call('suggest', { field: 'new-password' })).rows as Array<Record<string, string>>
    expect(rows[0]!['kind']).toBe('generate')
    expect(String((await page.call('generate', {}))['password'])).toHaveLength(20)
  })
})

describe('offer to save', () => {
  it('offers Save for a new login and saves it on yes; the same password again offers nothing', async () => {
    const { page } = await attach(true)
    const answer = await page.call('submitted', { username: 'new@site.org', password: 'fresh-pass-1' }, 'https://accounts.site.org/login')
    const offer = answer['offer'] as Record<string, string>
    expect(offer).toMatchObject({ mode: 'save', site: 'site.org', username: 'new@site.org' })
    expect(JSON.stringify(answer)).not.toContain('fresh-pass-1')
    await page.call('offer', { token: offer['token'], choice: 'save' }, 'https://accounts.site.org/home')
    const saved = vault.loginsFor('site.org')
    expect(saved).toHaveLength(1)
    expect(saved[0]!.values['password']).toBe('fresh-pass-1')
    expect(await page.call('submitted', { username: 'new@site.org', password: 'fresh-pass-1' }, 'https://accounts.site.org/login')).toEqual({})
  })

  it('offers Update for a changed password, remembers the username from step one, and shows the offer after navigation', async () => {
    const { page } = await attach(true)
    await page.call('username', { username: 'me@example.com' })
    const answer = await page.call('submitted', { username: '', password: 'changed-pass-2' })
    const offer = answer['offer'] as Record<string, string>
    expect(offer).toMatchObject({ mode: 'update', username: 'me@example.com' })
    expect((await page.call('hello', {})).offer).toMatchObject({ token: offer['token'] })
    await page.call('offer', { token: offer['token'], choice: 'save' })
    expect(vault.loginsFor('example.com')[0]!.values['password']).toBe('changed-pass-2')
  })

  it('Never for this site stops offers there', async () => {
    const { page } = await attach(true)
    const offer = (await page.call('submitted', { username: 'a', password: 'b-123456' }, 'https://x.net/')).offer as Record<string, string>
    await page.call('offer', { token: offer['token'], choice: 'never' }, 'https://x.net/')
    expect(vault.prefs().never).toContain('x.net')
    expect(await page.call('submitted', { username: 'a', password: 'c-123456' }, 'https://x.net/')).toEqual({})
  })

  it("Don't ask me saves without a prompt; offers off saves nothing", async () => {
    vault.setPrefs({ dontAsk: true })
    const { page } = await attach(true)
    expect(await page.call('submitted', { username: 'u', password: 'auto-pass-3' }, 'https://auto.io/')).toEqual({})
    expect(vault.loginsFor('auto.io')[0]?.values['password']).toBe('auto-pass-3')
    vault.setPrefs({ dontAsk: false, offerSave: false })
    expect(await page.call('submitted', { username: 'u', password: 'other-pass-4' }, 'https://quiet.io/')).toEqual({})
    expect(vault.loginsFor('quiet.io')).toHaveLength(0)
  })

  it('an agent typing a password gets no offer', async () => {
    const { page } = await attach(false)
    expect(await page.call('submitted', { username: 'u', password: 'agent-pass-5' }, 'https://agent.io/')).toEqual({})
  })
})

describe('passkeys', () => {
  const made = { credentialId: 'Y3JlZC1pZA==', rpId: 'demo.example', privateKey: 'cHJpdmF0ZS1rZXk=', userHandle: 'dXNlcg==', signCount: 0, isResidentCredential: true }

  it('the person says yes: a virtual authenticator makes the passkey and it goes into the Vault', async () => {
    const { page } = await attach(true)
    const pending = page.call('passkey', { pid: 1, kind: 'create', rpId: 'demo.example', rpName: 'Demo', user: 'alice' }, 'https://demo.example/register')
    for (let i = 0; i < 100 && page.pushes.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
    const prompt = page.pushes[0] as Record<string, string>
    expect(prompt).toMatchObject({ type: 'passkey', op: 'create', site: 'Demo', user: 'alice' })
    await page.call('passkeyAnswer', { token: prompt['token'], yes: true }, 'https://demo.example/register')
    expect(await pending).toEqual({ answer: 'vault' })
    expect(page.sent.map((s) => s.method)).toContain('WebAuthn.addVirtualAuthenticator')
    page.authenticatorCreds.push(made)
    await page.call('passkeyDone', { pid: 1 }, 'https://demo.example/register')
    const keys = vault.passkeysFor('demo.example')
    expect(keys).toHaveLength(1)
    expect(keys[0]!.passkey).toMatchObject({ credentialId: made.credentialId, rpId: 'demo.example' })
    expect(keys[0]!.username).toBe('alice')
    expect(JSON.stringify(vault.list())).not.toContain(made.privateKey)
    expect(page.sent.map((s) => s.method)).toContain('WebAuthn.removeVirtualAuthenticator')
  })

  it('Not now leaves the page to the system; a page cannot ask for another site', async () => {
    const { page } = await attach(true)
    const pending = page.call('passkey', { pid: 2, kind: 'create', rpId: 'demo.example', user: 'bob' }, 'https://demo.example/')
    for (let i = 0; i < 100 && page.pushes.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
    await page.call('passkeyAnswer', { token: (page.pushes[0] as Record<string, string>)['token'], yes: false }, 'https://demo.example/')
    expect(await pending).toEqual({ answer: 'native' })
    expect(await page.call('passkey', { pid: 3, kind: 'get', rpId: 'bank.example' }, 'https://demo.example/')).toEqual({ answer: 'native' })
  })

  it('an agent is refused until the person says yes (vault_passkey), then the vault key is loaded', async () => {
    vault.savePasskey({ ...made, userName: 'alice' }, 'person')
    const { page, bv } = await attach(false)
    expect(await page.call('passkey', { pid: 4, kind: 'get', rpId: 'demo.example' }, 'https://demo.example/login')).toEqual({ answer: 'deny' })
    const tool = toolNamed(guardTools(vaultTools({ vault, browserVault: bv }), vault), 'vault_passkey')
    const asked: string[] = []
    expect(await tool.run({ site: 'demo.example', why: 'sign in' }, testContext({ approve: async (s) => (asked.push(s), false) }))).toMatch(/did not allow/)
    expect(await page.call('passkey', { pid: 5, kind: 'get', rpId: 'demo.example' }, 'https://demo.example/login')).toEqual({ answer: 'deny' })
    await tool.run({ site: 'demo.example', why: 'sign in' }, testContext({ approve: async () => true }))
    expect(asked).toHaveLength(1)
    expect(await page.call('passkey', { pid: 6, kind: 'get', rpId: 'demo.example' }, 'https://demo.example/login')).toEqual({ answer: 'vault' })
    const added = page.sent.find((s) => s.method === 'WebAuthn.addCredential')
    expect((added?.params['credential'] as Record<string, unknown>)['privateKey']).toBe(made.privateKey)
    page.authenticatorCreds[0]!['signCount'] = 3
    await page.call('passkeyDone', { pid: 6 }, 'https://demo.example/login')
    expect(vault.passkeysFor('demo.example')[0]!.passkey?.signCount).toBe(3)
  })

  it("with Don't ask me an agent's passkey works without a yes; with asking on, the person's prompt shows", async () => {
    vault.savePasskey({ ...made, userName: 'alice' }, 'person')
    vault.setPrefs({ dontAsk: true })
    const agent = await attach(false)
    expect(await agent.page.call('passkey', { pid: 7, kind: 'get', rpId: 'demo.example' }, 'https://demo.example/')).toEqual({ answer: 'vault' })
    const person = await attach(true)
    expect(await person.page.call('passkey', { pid: 8, kind: 'get', rpId: 'demo.example' }, 'https://demo.example/')).toEqual({ answer: 'vault' })
    expect(person.page.pushes).toHaveLength(0)
  })
})

describe('asking for agents', () => {
  const tools = (): Tool[] => guardTools(vaultTools({ vault }), vault)

  it('reveal asks by default and not with "Don\'t ask me" or askReveal off', async () => {
    expect(vault.prefs()).toMatchObject({ askReveal: true, askPasskey: true, offerSave: true, dontAsk: false })
    let asked = 0
    const ctx = testContext({ approve: async () => ((asked += 1), true) })
    await toolNamed(tools(), 'vault_reveal').run({ item: 'example', why: 'x' }, ctx)
    expect(asked).toBe(1)
    vault.setPrefs({ dontAsk: true })
    expect(await toolNamed(tools(), 'vault_reveal').run({ item: 'example', why: 'x' }, ctx)).toContain(PASSWORD)
    expect(asked).toBe(1)
    vault.setPrefs({ dontAsk: false, askReveal: false })
    await toolNamed(tools(), 'vault_reveal').run({ item: 'example', why: 'x' }, ctx)
    expect(asked).toBe(1)
  })

  it('the settings travel with the vault to another brain', () => {
    vault.setPrefs({ askPasskey: false, never: ['a.com'] })
    const other = new VaultStore(new Secrets(join(dir, 'other'), new FileKeyCipher(join(dir, 'other.key'))))
    other.replaceAll(JSON.parse(JSON.stringify(vault.exportAll())))
    expect(other.prefs()).toMatchObject({ askPasskey: false, never: ['a.com'] })
  })
})
