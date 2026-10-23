/**
 * The Vault inside the in-app browser, the way a browser's own password manager works, plus passkeys.
 *
 * Attached to every tab, popup window and cross-site frame through its debugger (on a headless node, through its
 * CDP socket). It puts page-scripts.ts into each document, answers its binding, and:
 *   - suggests the logins saved for the page's site under a login field; a click fills them (person's tabs only;
 *     agents use vault_fill and vault_login, the same site matching);
 *   - offers a strong password on a new-password field;
 *   - offers to save or update a password the person submits (a Save / Update prompt, Never for this site, Not now),
 *     or saves it without asking when the person chose "Don't ask me";
 *   - makes and uses passkeys from the Vault: when a page asks for one, the person confirms in a small prompt (or an
 *     agent has the person's yes through vault_passkey), and only then a CDP virtual authenticator is added to that
 *     page with the vault's keys for that site; when the call ends, a new passkey (or a newer sign count) goes back
 *     into the Vault and the authenticator is removed. "Not now" leaves the page to the system's own passkeys.
 *
 * Values never leave the app's own process except into the page field or the authenticator they are meant for.
 */
import { randomBytes, randomInt } from 'node:crypto'

import { hostMatches, registrableDomain } from '@agent/core'

import type { VaultRecord, VaultStore } from './store'
import { PASSKEY_HOOK, VAULT_BINDING, VAULT_WORLD, VAULT_WORLD_SCRIPT } from './page-scripts'

export interface VaultLink {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>
  onEvent(listener: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void
}

export interface VaultAttachOptions {
  /** True when the person (not an agent) is the one using this page now. */
  person: () => boolean
  /** The profile of the agent the page belongs to, for which items it may see. */
  profile?: () => string | undefined
  /** Also attach to cross-site frames (desktop). */
  frames?: boolean
}

interface Offer {
  token: string
  site: string
  host: string
  username: string
  password: string
  itemId: string | null
  mode: 'save' | 'update'
  at: number
  from: Attachment
}

interface PasskeyOp {
  pid: number
  kind: 'get' | 'create'
  rpId: string
  rpName: string
  user: string
  sessionId: string | undefined
  authenticatorId: string
}

interface Waiting {
  pid: number
  rpId: string
  host: string
  contextId: number
  sessionId: string | undefined
}

interface Attachment {
  link: VaultLink
  options: VaultAttachOptions
  op: PasskeyOp | null
  conditional: Waiting | null
  lastUsername: { site: string; username: string; at: number } | null
}

const OFFER_MS = 2 * 60_000
const USERNAME_MS = 10 * 60_000
const ARM_MS = 3 * 60_000
const PROMPT_MS = 2 * 60_000

export class BrowserVault {
  private readonly offers = new Map<string, Offer>()
  private readonly prompts = new Map<string, (yes: boolean) => void>()
  private readonly armed = new Map<string, number>()

  constructor(
    private readonly vault: VaultStore,
    private readonly log: (message: string, detail?: Record<string, string | number>) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** An agent has the person's yes to use a passkey on this site for a few minutes (vault_passkey). */
  arm(site: string, ms = ARM_MS): void {
    const key = registrableDomain(site)
    if (key !== '') this.armed.set(key, this.now() + ms)
  }

  armedFor(rpId: string): boolean {
    const until = this.armed.get(registrableDomain(rpId))
    return until !== undefined && until > this.now()
  }

  /** Start serving one page target. Returns a function that stops listening. */
  async attach(link: VaultLink, options: VaultAttachOptions): Promise<() => void> {
    const at: Attachment = { link, options, op: null, conditional: null, lastUsername: null }
    const off = link.onEvent((method, params, sessionId) => {
      if (method === 'Runtime.bindingCalled' && params['name'] === VAULT_BINDING) {
        void this.onCall(at, String(params['payload'] ?? ''), Number(params['executionContextId']), sessionId)
      } else if (method === 'Target.attachedToTarget' && options.frames === true) {
        const info = (params['targetInfo'] ?? {}) as Record<string, unknown>
        const sid = typeof params['sessionId'] === 'string' ? params['sessionId'] : undefined
        if (sid !== undefined && info['type'] === 'iframe') void this.setup(link, sid)
      }
    })
    await this.setup(link, undefined)
    if (options.frames === true) {
      await link.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe' }] }).catch(() => undefined)
    }
    return () => {
      off()
      void this.endPasskey(at)
    }
  }

  private async setup(link: VaultLink, sessionId: string | undefined): Promise<void> {
    const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => link.send(method, params, sessionId).catch(() => undefined)
    await send('Runtime.enable')
    await send('Page.enable')
    await send('Runtime.addBinding', { name: VAULT_BINDING, executionContextName: VAULT_WORLD })
    await send('Page.addScriptToEvaluateOnNewDocument', { source: VAULT_WORLD_SCRIPT, worldName: VAULT_WORLD, runImmediately: true })
    await send('Page.addScriptToEvaluateOnNewDocument', { source: PASSKEY_HOOK, runImmediately: true })
  }

  // ---- the page world's calls ----

  private async onCall(at: Attachment, payload: string, contextId: number, sessionId: string | undefined): Promise<void> {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(payload) as Record<string, unknown>
    } catch {
      return
    }
    const id = typeof msg['id'] === 'number' ? msg['id'] : 0
    let host = ''
    try {
      host = new URL(String(msg['href'] ?? '')).hostname.toLowerCase()
    } catch {
      host = ''
    }
    let answer: unknown = {}
    try {
      answer = await this.handle(at, String(msg['op'] ?? ''), msg, host, contextId, sessionId)
    } catch (error) {
      this.log('Vault browser call failed', { op: String(msg['op'] ?? ''), error: error instanceof Error ? error.message : String(error) })
      answer = {}
    }
    await this.reply(at.link, contextId, sessionId, id, answer)
  }

  private reply(link: VaultLink, contextId: number, sessionId: string | undefined, id: number, data: unknown): Promise<unknown> {
    return link.send('Runtime.evaluate', { contextId, expression: `globalThis.__agentVaultReply && globalThis.__agentVaultReply(${id}, ${JSON.stringify(data ?? {})})` }, sessionId).catch(() => undefined)
  }

  private push(link: VaultLink, contextId: number, sessionId: string | undefined, data: unknown): Promise<unknown> {
    return link.send('Runtime.evaluate', { contextId, expression: `globalThis.__agentVaultPush && globalThis.__agentVaultPush(${JSON.stringify(JSON.stringify(data))})` }, sessionId).catch(() => undefined)
  }

  private async handle(at: Attachment, op: string, msg: Record<string, unknown>, host: string, contextId: number, sessionId: string | undefined): Promise<unknown> {
    const person = at.options.person()
    const profile = at.options.profile?.()
    const site = registrableDomain(host)
    switch (op) {
      case 'hello': {
        if (!person || msg['top'] !== true) return {}
        const offer = this.openOffer(at, site)
        return offer === null ? {} : { offer: this.offerView(offer) }
      }
      case 'suggest': {
        if (!person || host === '') return { rows: [] }
        const field = String(msg['field'] ?? '')
        if (field === 'new-password') return { head: 'Vault', rows: [{ kind: 'generate', label: 'Use a strong password', sub: 'Made for you; save it when you submit' }] }
        const rows: Array<Record<string, string>> = []
        const waiting = at.conditional
        if (waiting !== null && field === 'username' && hostMatches([waiting.rpId], host)) {
          for (const item of this.vault.passkeysFor(waiting.rpId)) rows.push({ kind: 'passkey', key: item.id, label: item.username === '' ? 'Passkey' : item.username, sub: `Passkey for ${waiting.rpId}` })
        }
        const remembered = at.lastUsername !== null && at.lastUsername.site === site && this.now() - at.lastUsername.at < USERNAME_MS ? at.lastUsername.username.toLowerCase() : ''
        const logins = this.vault.loginsFor(host, profile).sort((a, b) => Number(this.userOf(b).toLowerCase() === remembered) - Number(this.userOf(a).toLowerCase() === remembered))
        for (const item of logins.slice(0, 8)) {
          const user = this.userOf(item)
          rows.push({ kind: 'login', key: item.id, label: user === '' ? item.name : user, sub: user === '' ? site : item.name })
        }
        return { head: rows.length === 0 ? '' : `Saved for ${site}`, rows }
      }
      case 'fill': {
        if (!person) return { ok: false }
        const item = this.vault.record(String(msg['key'] ?? ''))
        // Only a login saved for this very site, and only one this page's profile may see.
        if (item === null || item.kind !== 'login' || !hostMatches(item.hosts, host)) return { ok: false }
        if (profile !== undefined && item.profile !== '' && item.profile !== profile) return { ok: false }
        this.vault.markUsed(item.id)
        return { ok: true, username: this.userOf(item), password: item.values['password'] ?? '' }
      }
      case 'generate':
        return person ? { password: generatePassword() } : {}
      case 'username': {
        const username = String(msg['username'] ?? '').trim()
        if (username !== '' && site !== '') at.lastUsername = { site, username, at: this.now() }
        return {}
      }
      case 'submitted':
        return person ? this.submitted(at, host, site, String(msg['username'] ?? '').trim(), String(msg['password'] ?? '')) : {}
      case 'offer': {
        const offer = this.offers.get(String(msg['token'] ?? ''))
        if (offer === undefined) return {}
        this.offers.delete(offer.token)
        const choice = String(msg['choice'] ?? '')
        if (choice === 'save') this.store(offer)
        if (choice === 'never') this.vault.never(offer.host)
        return {}
      }
      case 'passkey':
        return this.passkeyAsked(at, msg, host, contextId, sessionId)
      case 'passkeyAnswer': {
        const done = this.prompts.get(String(msg['token'] ?? ''))
        if (done !== undefined) done(msg['yes'] === true)
        return {}
      }
      case 'passkeyPick': {
        const waiting = at.conditional
        const item = this.vault.record(String(msg['key'] ?? ''))
        if (!person || waiting === null || item === null || item.kind !== 'passkey' || item.passkey?.rpId !== waiting.rpId) return {}
        at.conditional = null
        // The person's click on the passkey in the list is the yes.
        await this.startPasskey(at, { pid: waiting.pid, kind: 'get', rpId: waiting.rpId, rpName: '', user: '' }, waiting.sessionId, [item])
        await this.push(at.link, waiting.contextId, waiting.sessionId, { type: 'passkeyAnswer', id: waiting.pid, answer: 'vault' })
        return {}
      }
      case 'passkeyDone': {
        const pid = Number(msg['pid'])
        if (at.conditional?.pid === pid) at.conditional = null
        if (at.op?.pid === pid) await this.endPasskey(at)
        return {}
      }
      default:
        return {}
    }
  }

  private userOf(item: VaultRecord): string {
    return item.values['username'] ?? item.username
  }

  // ---- passwords the person types ----

  private submitted(at: Attachment, host: string, site: string, typedUser: string, password: string): unknown {
    if (site === '' || password === '') return {}
    const prefs = this.vault.prefs()
    if (prefs.never.includes(site)) return {}
    let username = typedUser
    if (username === '' && at.lastUsername !== null && at.lastUsername.site === site && this.now() - at.lastUsername.at < USERNAME_MS) username = at.lastUsername.username
    const logins = this.vault.loginsFor(host, at.options.profile?.())
    const same = logins.filter((item) => this.userOf(item).toLowerCase() === username.toLowerCase())
    const match = same[0] ?? (username === '' && logins.length === 1 ? logins[0]! : null)
    if (match !== null && match.values['password'] === password) {
      this.vault.markUsed(match.id)
      return {}
    }
    const offer: Offer = { token: randomBytes(12).toString('hex'), site, host, username: username === '' && match !== null ? this.userOf(match) : username, password, itemId: match?.id ?? null, mode: match === null ? 'save' : 'update', at: this.now(), from: at }
    // "Don't ask me": saved straight away. Offers switched off: nothing is kept.
    if (prefs.dontAsk) {
      this.store(offer)
      return {}
    }
    if (!prefs.offerSave) return {}
    for (const [token, old] of this.offers) if (old.from === at || this.now() - old.at > OFFER_MS) this.offers.delete(token)
    this.offers.set(offer.token, offer)
    return { offer: this.offerView(offer) }
  }

  private openOffer(at: Attachment, site: string): Offer | null {
    let best: Offer | null = null
    for (const [token, offer] of this.offers) {
      if (this.now() - offer.at > OFFER_MS) {
        this.offers.delete(token)
        continue
      }
      // Its own tab, or the tab a sign-in window came back to (same site, just now).
      if (offer.from === at || (offer.site === site && this.now() - offer.at < 60_000)) best = offer
    }
    return best
  }

  private offerView(offer: Offer): Record<string, string> {
    return { token: offer.token, mode: offer.mode, site: offer.site, username: offer.username }
  }

  private store(offer: Offer): void {
    if (offer.itemId !== null) {
      const item = this.vault.record(offer.itemId)
      if (item !== null) {
        this.vault.save({ id: item.id, name: item.name, fields: { password: offer.password }, ...(item.username === '' && offer.username !== '' ? { username: offer.username } : {}) }, 'person')
        return
      }
    }
    this.vault.save({ name: offer.site, kind: 'login', username: offer.username, url: `https://${offer.host}`, hosts: [offer.host], source: 'browser', fields: { password: offer.password } }, 'person')
  }

  // ---- passkeys ----

  private async passkeyAsked(at: Attachment, msg: Record<string, unknown>, host: string, contextId: number, sessionId: string | undefined): Promise<unknown> {
    const pid = Number(msg['pid'])
    const kind = msg['kind'] === 'create' ? 'create' : 'get'
    const rpId = String(msg['rpId'] ?? '').toLowerCase()
    // A page may only ask for its own site's passkeys.
    if (rpId === '' || !(host === rpId || host.endsWith(`.${rpId}`))) return { answer: 'native' }
    const rpName = String(msg['rpName'] ?? '')
    const user = String(msg['user'] ?? '')
    const keys = kind === 'get' ? this.vault.passkeysFor(rpId) : []
    if (kind === 'get' && keys.length === 0) return { answer: 'native' }
    if (kind === 'get' && msg['conditional'] === true) {
      // Wait for the person to pick it in the list under the username field (or for the page to give up).
      at.conditional = { pid, rpId, host, contextId, sessionId }
      return { answer: at.options.person() ? 'wait' : 'native' }
    }
    const yes = await this.decide(at, kind, rpId, rpName || rpId, user, contextId, sessionId)
    if (yes === 'deny') {
      this.log('Passkey refused for an agent without the person’s yes', { site: rpId })
      return { answer: 'deny' }
    }
    if (yes === 'native') return { answer: 'native' }
    await this.startPasskey(at, { pid, kind, rpId, rpName, user }, sessionId, keys)
    return { answer: 'vault' }
  }

  private async decide(at: Attachment, kind: 'get' | 'create', rpId: string, site: string, user: string, contextId: number, sessionId: string | undefined): Promise<'vault' | 'native' | 'deny'> {
    const asks = this.vault.asks('passkey')
    if (!at.options.person()) return !asks || this.armedFor(rpId) ? 'vault' : 'deny'
    if (!asks) return 'vault'
    const token = randomBytes(12).toString('hex')
    const answer = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), PROMPT_MS)
      const finish = (yes: boolean): void => {
        clearTimeout(timer)
        this.prompts.delete(token)
        resolve(yes)
      }
      this.prompts.set(token, finish)
    })
    await this.push(at.link, contextId, sessionId, { type: 'passkey', token, op: kind, site, user })
    return (await answer) ? 'vault' : 'native'
  }

  private async startPasskey(at: Attachment, op: Omit<PasskeyOp, 'sessionId' | 'authenticatorId'>, sessionId: string | undefined, keys: VaultRecord[]): Promise<void> {
    if (at.op !== null) await this.endPasskey(at)
    const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => at.link.send(method, params, sessionId)
    await send('WebAuthn.enable', { enableUI: false })
    const made = (await send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    })) as { authenticatorId?: string }
    const authenticatorId = String(made?.authenticatorId ?? '')
    at.op = { ...op, sessionId, authenticatorId }
    for (const item of keys) {
      const pk = item.passkey
      const privateKey = item.values['privateKey']
      if (pk === undefined || privateKey === undefined) continue
      await send('WebAuthn.addCredential', {
        authenticatorId,
        credential: { credentialId: pk.credentialId, isResidentCredential: true, rpId: pk.rpId, privateKey, userHandle: pk.userHandle, signCount: pk.signCount },
      })
      this.vault.markUsed(item.id)
    }
  }

  /** Read back what the authenticator holds (a new passkey, a higher sign count), then take it away. */
  private async endPasskey(at: Attachment): Promise<void> {
    const op = at.op
    if (op === null) return
    at.op = null
    const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => at.link.send(method, params, op.sessionId)
    try {
      const got = (await send('WebAuthn.getCredentials', { authenticatorId: op.authenticatorId })) as { credentials?: Array<Record<string, unknown>> }
      for (const cred of got?.credentials ?? []) {
        const credentialId = String(cred['credentialId'] ?? '')
        const privateKey = String(cred['privateKey'] ?? '')
        if (credentialId === '' || privateKey === '') continue
        const known = this.vault.passkeysFor(String(cred['rpId'] ?? op.rpId)).some((item) => item.passkey?.credentialId === credentialId)
        if (!known && op.kind !== 'create') continue
        this.vault.savePasskey(
          {
            rpId: String(cred['rpId'] ?? op.rpId),
            rpName: op.rpName,
            userName: op.user || String(cred['userName'] ?? ''),
            credentialId,
            userHandle: String(cred['userHandle'] ?? ''),
            signCount: Number(cred['signCount'] ?? 0),
            privateKey,
          },
          at.options.person() ? 'person' : 'agent',
        )
      }
    } catch (error) {
      this.log('Passkey read-back failed', { error: error instanceof Error ? error.message : String(error) })
    } finally {
      await send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: op.authenticatorId }).catch(() => undefined)
      await send('WebAuthn.disable').catch(() => undefined)
    }
  }
}

const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGITS = '23456789'
const SYMBOLS = '-_.!@#%+='

/** A strong password: 20 characters, every kind at least once, no look-alikes. */
export function generatePassword(length = 20): string {
  const all = LOWER + UPPER + DIGITS + SYMBOLS
  const chars = [LOWER, UPPER, DIGITS, SYMBOLS].map((set) => set[randomInt(set.length)]!)
  while (chars.length < length) chars.push(all[randomInt(all.length)]!)
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
  }
  return chars.join('')
}
