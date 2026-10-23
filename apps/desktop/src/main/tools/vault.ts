/**
 * The Vault tools (vault/store.ts): the agent uses a password or key without ever seeing it.
 *
 *   vault_list    names, kinds, hosts, fields. Never a value.
 *   vault_fill    types one field's value into a page field, targeted the way browser_act targets.
 *   vault_login   fills the username and password of the item for the page that is open.
 *   vault_save    stores a secret the agent was given or made (a key it just created on a site).
 *   vault_reveal  hands a value to the agent: asks the person first, unless the item is marked revealable. Logged.
 *
 * Every other tool takes `{{vault:ref}}` or `{{vault:ref.field}}` (vault/guard.ts).
 */
import { VAULT_DEFAULT_FIELD, VAULT_KINDS, bool, enumOf, int, schema, str, strList, type JsonObject, type Tool, type VaultItemMeta, type VaultKind } from '@agent/core'

import { isBrowserPro, type BrowserDriver } from '../browser/types'
import type { VaultStore } from '../vault/store'

export interface VaultToolDeps {
  vault: VaultStore
  browser?: BrowserDriver
}

export function vaultTools(deps: VaultToolDeps): Tool[] {
  return [listTool(deps), fillTool(deps), loginTool(deps), saveTool(deps), revealTool(deps)]
}

const PLACEHOLDER_HELP =
  'Use a value without seeing it: write {{vault:REF}} (its main field) or {{vault:REF.field}} in browser_fetch, web_fetch, browser_act text, browser_eval, worker_secret_set, files_write, apps_run and webapp_run; shell_run and run_code take it too (a shell gets it as an environment variable). Results show it as [vault:REF].'

function line(item: VaultItemMeta): string {
  const bits = [`${item.ref}`, item.kind, item.name]
  if (item.username !== '') bits.push(`user ${item.username}`)
  if (item.hosts.length > 0) bits.push(`hosts ${item.hosts.join(' ')}`)
  bits.push(`fields ${item.fields.length === 0 ? '(none)' : item.fields.join(', ')}`)
  if (item.tags.length > 0) bits.push(`tags ${item.tags.join(', ')}`)
  if (item.revealable) bits.push('revealable')
  return bits.join(' | ')
}

function listTool(deps: VaultToolDeps): Tool {
  return {
    spec: {
      name: 'vault_list',
      description: `What is in the person's Vault (passwords, logins, API keys, tokens): ref, kind, name, username, hosts, which secret fields it has. Never the values. ${PLACEHOLDER_HELP}`,
      schema: schema([], {
        query: str('Only items whose name, ref, username, host or tag contains this'),
        kind: enumOf('Only this kind', ...VAULT_KINDS),
      }),
    },
    run: async (input, ctx) => {
      const q = text(input['query']).trim().toLowerCase()
      const kind = text(input['kind'])
      const items = deps.vault
        .list(ctx.profile)
        .filter((item) => kind === '' || item.kind === kind)
        .filter((item) => q === '' || [item.name, item.ref, item.username, item.url, item.hosts.join(' '), item.tags.join(' '), item.notes].join(' ').toLowerCase().includes(q))
      if (items.length === 0) return q === '' ? 'The vault is empty. Save one with vault_save.' : `Nothing in the vault matches "${q}".`
      return `${items.length} item${items.length === 1 ? '' : 's'} (ref | kind | name | ...):\n${items.map(line).join('\n')}`
    },
  }
}

function fillTool(deps: VaultToolDeps): Tool {
  return {
    spec: {
      name: 'vault_fill',
      description:
        'Type a vault value into a field on the open page with trusted input, without seeing it. Target it the way browser_act does: by name as the snapshot prints it (with role and nth), or by index, or at_x/at_y. field defaults to the item\'s main secret (password, key, token); use field username for the login name. submit presses Enter after.',
      schema: schema(['item'], {
        item: str('The vault item: its ref, id or exact name'),
        field: str('Which field, default the main secret; username for the login name'),
        name: str('The element name as the snapshot shows it'),
        role: str('textbox, searchbox...'),
        nth: int('Which one when several match, 1 is the first'),
        index: int('Element number from the snapshot'),
        at_x: int('X in screenshot pixels'),
        at_y: int('Y in screenshot pixels'),
        submit: bool('Press Enter after typing'),
      }),
    },
    run: async (input, ctx) => {
      const browser = deps.browser
      if (browser === undefined || !isBrowserPro(browser)) return 'The browser is not open right now.'
      const field = text(input['field']).trim()
      const hit = deps.vault.resolve(text(input['item']), field === '' ? undefined : field, ctx.profile)
      if ('error' in hit) return hit.error
      const index = number(input['index'])
      const nth = number(input['nth'])
      const atX = number(input['at_x'])
      const atY = number(input['at_y'])
      const name = text(input['name']).trim()
      if (index === null && name === '' && (atX === null || atY === null)) return 'Say which field: its name from the snapshot, its index, or at_x and at_y.'
      deps.vault.markUsed(hit.item.id)
      const answer = await browser.act({
        action: 'type',
        text: hit.value,
        ...(index === null ? {} : { index: Math.floor(index) }),
        ...(name === '' ? {} : { name }),
        ...(text(input['role']).trim() === '' ? {} : { role: text(input['role']).trim() }),
        ...(nth === null ? {} : { nth: Math.floor(nth) }),
        ...(atX === null || atY === null ? {} : { at: { x: atX, y: atY } }),
        ...(input['submit'] === true ? { submit: true } : {}),
      })
      // The guard takes the value out of the page text that comes back; say what was done in plain words first.
      return `Filled ${hit.item.ref}.${hit.field} into the field (the value is not shown).\n\n${answer}`
    },
  }
}

/** Runs in the page: finds the login form's fields and sets them the way React and friends notice. */
const LOGIN_SCRIPT = `(async (user, pass, submit) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled; };
  const set = (el, value) => {
    el.focus();
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    desc.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  };
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const pw = inputs.find((el) => el.type === 'password');
  const before = pw ? inputs.slice(0, inputs.indexOf(pw)) : inputs;
  const userField = [...before].reverse().find((el) => /^(text|email|tel|)$/.test(el.type) && !/search/i.test(el.name + el.id)) ||
    inputs.find((el) => /user|email|login|account|identifier/i.test([el.name, el.id, el.autocomplete, el.placeholder, el.getAttribute('aria-label')].join(' ')) && el.type !== 'password');
  const done = [];
  if (user !== null && userField) { set(userField, user); done.push('username'); }
  if (pass !== null && pw) { set(pw, pass); done.push('password'); }
  if (submit && done.length > 0) {
    const form = (pw || userField).form;
    const button = form ? form.querySelector('button[type=submit], input[type=submit], button:not([type])') : null;
    if (button) button.click(); else if (form && form.requestSubmit) form.requestSubmit();
    done.push('submitted');
  }
  return { done, sawPassword: !!pw, sawUser: !!userField };
})`

function loginTool(deps: VaultToolDeps): Tool {
  return {
    spec: {
      name: 'vault_login',
      description:
        "Sign in on the open page with a vault login, without seeing it: fills the username and the password fields (and submits when asked). With no item it picks the login whose host matches the page. On a two-step sign-in (username, then password on the next screen) call it again on each screen. If a site ignores it, use vault_fill on each field (trusted typing).",
      schema: schema([], {
        item: str('The vault login: its ref, id or exact name. Leave out to use the one for this site'),
        submit: bool('Submit the form after filling'),
      }),
    },
    run: async (input, ctx) => {
      const browser = deps.browser
      if (browser === undefined || browser.evaluateRaw === undefined) return 'The browser is not open right now.'
      const pageUrl = browser.currentUrl?.() ?? ''
      let host = ''
      try {
        host = new URL(pageUrl).hostname.toLowerCase()
      } catch {
        return 'No page is open yet. Use browser_open with the sign-in page.'
      }
      let ref = text(input['item']).trim()
      if (ref === '') {
        const matches = deps.vault.list(ctx.profile).filter((item) => item.kind === 'login' && item.hosts.some((h) => host === h || host.endsWith(`.${h}`) || h.endsWith(`.${host}`)))
        if (matches.length === 0) return `No vault login is for ${host}. vault_list shows what is there; pass item.`
        if (matches.length > 1) return `${matches.length} vault logins are for ${host}: ${matches.map((m) => `${m.ref} (${m.username || 'no username'})`).join('; ')}. Pass item.`
        ref = matches[0]!.ref
      }
      const pass = deps.vault.resolve(ref, 'password', ctx.profile)
      if ('error' in pass) return pass.error
      const item = pass.item
      const user = item.values['username'] ?? (item.username === '' ? null : item.username)
      deps.vault.markUsed(item.id)
      const code = `${LOGIN_SCRIPT}(${JSON.stringify(user)}, ${JSON.stringify(pass.value)}, ${input['submit'] === true})`
      let outcome: unknown
      try {
        outcome = await browser.evaluateRaw(code, 15_000)
      } catch (error) {
        return `The page did not take it: ${error instanceof Error ? error.message : String(error)}`
      }
      const done = Array.isArray((outcome as { done?: unknown } | null)?.done) ? ((outcome as { done: string[] }).done) : []
      if (done.length === 0) return `I found no sign-in fields on ${host}. Take a snapshot, then use vault_fill on the field.`
      return `Filled ${done.filter((d) => d !== 'submitted').join(' and ')} for ${item.ref} on ${host}${done.includes('submitted') ? ' and submitted the form' : ''}. The values are not shown. Take a snapshot to see what happened.`
    },
  }
}

function saveTool(deps: VaultToolDeps): Tool {
  return {
    spec: {
      name: 'vault_save',
      description:
        'Store a password, API key or token in the Vault instead of anywhere else (never in memory, a task or a file). Use it for a key you just created on a site or one the person gave you. Pass the value in fields (login: username and password; api_key: key; token: token; note: text). To store a value that is on the page without reading it, pass from_page with a CSS selector of the element holding it. Saving with an existing ref or id updates it.',
      schema: schema(['name'], {
        name: str('What it is, e.g. "Groq API key (personal)"'),
        ref: str('Short handle for placeholders, lower case and dashes; made from the name when left out'),
        id: str('The item id, to update an existing one'),
        kind: enumOf('What kind', ...VAULT_KINDS),
        username: str('Login name or email (not secret)'),
        url: str('Where it is used'),
        notes: str('Hints that are not secret: which account, rules, how to reset'),
        tags: strList('Tags'),
        fields: { type: 'object', description: 'Secret fields, e.g. {"password": "..."} or {"key": "..."}', additionalProperties: { type: 'string' } },
        from_page: str('CSS selector of the element on the open page whose value or text is the secret (it is read inside the app, not shown to you)'),
        from_page_field: str('Which field the value from the page goes in, default the main one for the kind'),
        revealable: bool('The person said agents may see this one without asking'),
      }),
    },
    run: async (input, ctx) => {
      const fields: Record<string, string> = {}
      const raw = input['fields']
      if (raw !== undefined && raw !== null) {
        if (typeof raw !== 'object' || Array.isArray(raw)) return 'fields is an object of field name to value.'
        for (const [key, value] of Object.entries(raw as JsonObject)) if (typeof value === 'string') fields[key] = value
      }
      const kindRaw = text(input['kind'])
      const kind: VaultKind = (VAULT_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as VaultKind) : 'login'
      const selector = text(input['from_page']).trim()
      if (selector !== '') {
        const browser = deps.browser
        if (browser?.evaluateRaw === undefined) return 'The browser is not open right now.'
        let value: unknown
        try {
          value = await browser.evaluateRaw(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; return ('value' in el && el.value) ? el.value : (el.textContent || '').trim(); })()`, 10_000)
        } catch (error) {
          return `Could not read it off the page: ${error instanceof Error ? error.message : String(error)}`
        }
        if (typeof value !== 'string' || value === '') return `Nothing on the page matches ${selector}, or it is empty.`
        fields[text(input['from_page_field']).trim() || VAULT_DEFAULT_FIELD[kind]] = value
      }
      const idIn = text(input['id']).trim()
      const refIn = text(input['ref']).trim().toLowerCase()
      const existing = idIn !== '' ? deps.vault.get(idIn) : refIn === '' ? null : deps.vault.list().find((item) => item.ref === refIn) ?? null
      if (existing === null && Object.keys(fields).length === 0) return 'Pass the secret in fields (or from_page).'
      try {
        const saved = deps.vault.save(
          {
            ...(existing === null ? {} : { id: existing.id }),
            name: text(input['name']),
            ...(refIn === '' ? {} : { ref: refIn }),
            ...(kindRaw === '' && existing !== null ? {} : { kind }),
            ...(typeof input['username'] === 'string' ? { username: input['username'] } : {}),
            ...(typeof input['url'] === 'string' ? { url: input['url'] } : {}),
            ...(typeof input['notes'] === 'string' ? { notes: input['notes'] } : {}),
            ...(Array.isArray(input['tags']) ? { tags: (input['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') } : {}),
            ...(typeof input['revealable'] === 'boolean' ? { revealable: input['revealable'] } : {}),
            ...(existing === null && ctx.profile !== undefined ? { profile: ctx.profile } : {}),
            source: existing?.source || 'agent',
            fields,
          },
          ctx.agentLabel,
        )
        return `${existing === null ? 'Saved' : 'Updated'} in the vault as ${saved.ref} (${saved.kind}; fields ${saved.fields.join(', ')}). Use it as {{vault:${saved.ref}}}. Do not write the value anywhere else; a memory may say it is in the vault under ${saved.ref}.`
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
  }
}

function revealTool(deps: VaultToolDeps): Tool {
  return {
    spec: {
      name: 'vault_reveal',
      description:
        'Show yourself a vault value. Only when there is truly no other way: placeholders, vault_fill and vault_login use a value without seeing it. Asks the person first unless the item is marked revealable. Every reveal is logged. Never repeat the value in a reply, a memory or a file.',
      schema: schema(['item', 'why'], {
        item: str('The vault item: its ref, id or exact name'),
        field: str('Which field, default the main secret'),
        why: str('Why you need to see it, in one line, for the person'),
      }),
    },
    run: async (input, ctx) => {
      const field = text(input['field']).trim()
      const hit = deps.vault.resolve(text(input['item']), field === '' ? undefined : field, ctx.profile)
      if ('error' in hit) return hit.error
      const why = text(input['why']).trim() || 'No reason given.'
      if (!hit.item.revealable) {
        const ok = await ctx.approve(`Show ${ctx.agentLabel} the ${hit.field} of "${hit.item.name}"`, `The agent asks to SEE this value, not just use it.\nWhy: ${why}\nIt is logged in the Vault.`)
        if (!ok) return 'The person did not approve showing it. Use it through a placeholder, vault_fill or vault_login instead.'
      }
      deps.vault.log(hit.item.id, 'reveal', ctx.agentLabel)
      return `${hit.item.ref}.${hit.field}: ${hit.value}\n(Do not repeat it in a reply, memory or file. It is kept out of the saved chat.)`
    },
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim())
  return null
}
