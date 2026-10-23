/**
 * The Vault in a real Chromium page: the real page scripts, the real WebAuthn virtual authenticator.
 * Autofill from the suggestion list, a save offer after the page moves on, and a passkey registered into the vault and
 * used again to sign in. Clicks are trusted mouse events at the Vault's own (closed) UI, found through the DOM domain.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FileKeyCipher } from '../src/headless/file-cipher'
import { Secrets } from '../src/main/secrets'
import { BrowserVault, type VaultLink } from '../src/main/vault/browser-vault'
import { VaultStore } from '../src/main/vault/store'

function findChrome(): string | null {
  const env = process.env.CHROME_PATH
  if (env !== undefined && env !== '' && existsSync(env)) return env
  const base = join(homedir(), '.cache/ms-playwright')
  if (!existsSync(base)) return null
  for (const dir of readdirSync(base).filter((name) => name.startsWith('chromium-')).sort().reverse()) {
    const path = join(base, dir, 'chrome-linux64/chrome')
    if (existsSync(path)) return path
  }
  return null
}

const PAGES: Record<string, string> = {
  '/login': `<!doctype html><html><body><h1>Sign in</h1><form method="post" action="/home">
    <input id="user" name="username" autocomplete="username"><input id="pass" name="password" type="password" autocomplete="current-password">
    <button type="submit">Sign in</button></form></body></html>`,
  '/home': '<!doctype html><html><body><h1>Welcome</h1></body></html>',
  '/signup': `<!doctype html><html><body><form><input id="nu" name="email" autocomplete="email"><input id="np" type="password" autocomplete="new-password"></form></body></html>`,
  '/webauthn': `<!doctype html><html><body><button id="reg">Register</button><button id="auth">Sign in with a passkey</button>
    <script>
      const rand = () => crypto.getRandomValues(new Uint8Array(32));
      document.getElementById('reg').onclick = async () => {
        try {
          const c = await navigator.credentials.create({ publicKey: { rp: { name: 'Demo site', id: 'localhost' }, user: { id: new Uint8Array([7, 7, 7]), name: 'alice', displayName: 'Alice' }, challenge: rand(), pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }, timeout: 20000 } });
          window.__reg = c.id;
        } catch (e) { window.__reg = 'error:' + e.name; }
      };
      document.getElementById('auth').onclick = async () => {
        try {
          const c = await navigator.credentials.get({ publicKey: { challenge: rand(), rpId: 'localhost', userVerification: 'preferred', timeout: 20000 } });
          window.__auth = c.id;
        } catch (e) { window.__auth = 'error:' + e.name; }
      };
    </script></body></html>`,
}

const chrome = findChrome()
const suite = chrome === null ? describe.skip : describe

function linkOf(session: CDPSession): VaultLink {
  return {
    send: (method, params) => session.send(method as never, params as never) as Promise<unknown>,
    onEvent: (listener) => {
      const on = (params: Record<string, unknown>): void => listener('Runtime.bindingCalled', params)
      session.on('Runtime.bindingCalled' as never, on as never)
      return () => session.off('Runtime.bindingCalled' as never, on as never)
    },
  }
}

interface DomNode {
  nodeId: number
  nodeName: string
  nodeValue?: string
  children?: DomNode[]
  shadowRoots?: DomNode[]
}

/** The Vault UI element whose text is exactly this, through closed shadow roots; clicked with the real mouse. */
async function clickVaultText(page: Page, session: CDPSession, text: string, timeoutMs = 8000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const { root } = (await session.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode }
    let found: number | null = null
    const walk = (node: DomNode, parent: DomNode | null, inVault: boolean): void => {
      const here = inVault || node.nodeName === 'AGENT-VAULT-UI'
      if (here && node.nodeName === '#text' && node.nodeValue === text && parent !== null) found ??= parent.nodeId
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child, node, here)
    }
    walk(root, null, false)
    if (found !== null) {
      const box = (await session.send('DOM.getBoxModel', { nodeId: found })) as { model: { content: number[] } }
      const q = box.model.content
      await page.mouse.click((q[0]! + q[4]!) / 2, (q[1]! + q[5]!) / 2)
      return
    }
    await page.waitForTimeout(150)
  }
  throw new Error(`no Vault UI text "${text}"`)
}

suite('the Vault in a real Chromium page', () => {
  let browser: Browser
  let server: Server
  let base = ''
  let dir = ''
  let vault: VaultStore

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0]!
      req.resume()
      res.writeHead(PAGES[path] === undefined ? 404 : 200, { 'content-type': 'text/html' })
      res.end(PAGES[path] ?? 'not here')
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    base = `http://localhost:${(server.address() as { port: number }).port}`
    browser = await chromium.launch({ executablePath: chrome ?? undefined, args: ['--no-sandbox'] })
    dir = mkdtempSync(join(tmpdir(), 'agent-vaultc-'))
    vault = new VaultStore(new Secrets(join(dir, 'secrets'), new FileKeyCipher(join(dir, 'secrets.key'))))
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function open(path: string): Promise<{ page: Page; session: CDPSession }> {
    const page = await browser.newPage()
    const session = await page.context().newCDPSession(page)
    await new BrowserVault(vault).attach(linkOf(session), { person: () => true })
    await page.goto(base + path)
    return { page, session }
  }

  it('fills a login from the suggestion list and offers to update a changed password after the page moves on', async () => {
    vault.save({ name: 'Local site', kind: 'login', username: 'alice@example.com', url: base, hosts: ['localhost'], fields: { password: 'old-secret-1' } })
    const { page, session } = await open('/login')
    await page.click('#user')
    await clickVaultText(page, session, 'alice@example.com')
    await expect.poll(() => page.inputValue('#user')).toBe('alice@example.com')
    expect(await page.inputValue('#pass')).toBe('old-secret-1')
    await page.fill('#pass', 'new-secret-2')
    await page.click('button[type=submit]')
    await page.waitForURL('**/home')
    await clickVaultText(page, session, 'Update')
    await expect.poll(() => vault.loginsFor('localhost')[0]!.values['password']).toBe('new-secret-2')
    await page.close()
  }, 60_000)

  it('offers a strong password on a new-password field', async () => {
    const { page, session } = await open('/signup')
    await page.click('#np')
    await clickVaultText(page, session, 'Use a strong password')
    await page.waitForTimeout(200)
    await expect.poll(async () => (await page.inputValue('#np')).length).toBe(20)
    await page.close()
  }, 60_000)

  it('registers a passkey into the vault after a yes, then signs in with it from the vault', async () => {
    const first = await open('/webauthn')
    await first.page.click('#reg')
    await clickVaultText(first.page, first.session, 'Save in Vault')
    await first.page.waitForFunction(() => (window as unknown as { __reg?: string }).__reg !== undefined, undefined, { timeout: 15_000 })
    const reg = await first.page.evaluate(() => (window as unknown as { __reg: string }).__reg)
    expect(reg).not.toMatch(/^error/)
    await first.page.waitForTimeout(300)
    const keys = vault.passkeysFor('localhost')
    expect(keys).toHaveLength(1)
    expect(keys[0]!.username).toBe('alice')
    await first.page.close()

    // A new page has no authenticator of its own: the only key it can sign with is the vault's.
    const second = await open('/webauthn')
    await second.page.click('#auth')
    await clickVaultText(second.page, second.session, 'Use passkey')
    await second.page.waitForFunction(() => (window as unknown as { __auth?: string }).__auth !== undefined, undefined, { timeout: 15_000 })
    expect(await second.page.evaluate(() => (window as unknown as { __auth: string }).__auth)).toBe(reg)
    await second.page.close()
  }, 90_000)
})
