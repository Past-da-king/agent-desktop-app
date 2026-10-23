/**
 * The Vault: an agent uses a secret without seeing it. Values never in a tool result, a run record, an activity line,
 * a stored row or the list; placeholders resolve in shell, code and fetch; reveal asks. Importing exports is in vault-import.test.ts.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { JsonObject, Tool } from '@agent/core'

import { FileKeyCipher } from '../src/headless/file-cipher'
import { Store } from '../src/main/db'
import { BundleKeeper, parseBundle } from '../src/main/devices/bundle'
import { redactSecrets } from '../src/main/logger'
import { Secrets } from '../src/main/secrets'
import { SettingsStore } from '../src/main/settings'
import { codeTools } from '../src/main/tools/code'
import { takeRun } from '../src/main/tools/run-capture'
import { shellTools } from '../src/main/tools/shell'
import { vaultTools } from '../src/main/tools/vault'
import { guardTool, guardTools } from '../src/main/vault/guard'
import { codeText, shellCommand, type VaultRun } from '../src/main/vault/placeholders'
import { setVaultRedactor } from '../src/main/vault/redact'
import { VaultStore } from '../src/main/vault/store'
import { settingsView, testContext, toolNamed } from './support'

const SECRET = 'sk-test-VAULT-' + randomBytes(8).toString('hex')
const PASSWORD = "p@ss'word\"with$chars-" + randomBytes(4).toString('hex')

let dir = ''
let vault: VaultStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-vault-'))
  vault = new VaultStore(new Secrets(join(dir, 'secrets'), new FileKeyCipher(join(dir, 'secrets.key'))))
  vault.save({ name: 'Test API key', ref: 'test-key', kind: 'api_key', url: 'https://api.example.com', fields: { key: SECRET } })
  vault.save({ name: 'Example login', ref: 'example', kind: 'login', username: 'me@example.com', url: 'https://login.example.com/start', fields: { password: PASSWORD } })
  setVaultRedactor((text) => vault.redact(text))
})

afterEach(() => {
  setVaultRedactor(null)
  rmSync(dir, { recursive: true, force: true })
})

function echoTool(name: string): Tool {
  return {
    spec: { name, description: 'echo', schema: { type: 'object' } },
    run: async (input, ctx) => {
      await ctx.activity(`Working with ${JSON.stringify(input)}`)
      return `got ${JSON.stringify(input)}`
    },
  }
}

describe('vault store', () => {
  it('keeps values encrypted at rest and out of every listing', () => {
    const files = readdirSync(join(dir, 'secrets'))
    expect(files).toContain('vault.secret')
    const bytes = readFileSync(join(dir, 'secrets', 'vault.secret'))
    expect(bytes.includes(Buffer.from(SECRET))).toBe(false)
    expect(bytes.includes(Buffer.from('Test API key'))).toBe(false)
    const listed = JSON.stringify(vault.list())
    expect(listed).not.toContain(SECRET)
    expect(listed).not.toContain(PASSWORD)
    expect(vault.list().find((item) => item.ref === 'test-key')?.fields).toEqual(['key'])
    expect(vault.list().find((item) => item.ref === 'example')?.hosts).toEqual(['login.example.com'])
  })

  it('an edit without a value keeps the old one; a new store reads the same file', () => {
    const item = vault.list().find((entry) => entry.ref === 'test-key')!
    vault.save({ id: item.id, name: 'Test API key (renamed)' })
    const again = new VaultStore(new Secrets(join(dir, 'secrets'), new FileKeyCipher(join(dir, 'secrets.key'))))
    const hit = again.resolve('test-key')
    expect('error' in hit ? hit.error : hit.value).toBe(SECRET)
    expect(again.list().find((entry) => entry.ref === 'test-key')?.name).toBe('Test API key (renamed)')
  })

  it('takes values out of text, also JSON-escaped and URL-encoded', () => {
    expect(vault.redact(`key=${SECRET}.`)).toBe('key=[vault:test-key].')
    expect(vault.redact(JSON.stringify({ p: PASSWORD }))).not.toContain('with$chars')
    expect(vault.redact(`?p=${encodeURIComponent(PASSWORD)}`)).toBe('?p=[vault:example]')
    expect(redactSecrets(`token ${SECRET}`)).not.toContain(SECRET)
  })

  it('the row store never keeps a vault value', async () => {
    const store = new Store(join(dir, 'agent.db'))
    const row = await store.upsert('chat_item', { kind: 'tool', text: `the key is ${SECRET}`, meta: JSON.stringify({ out: PASSWORD }) })
    expect(JSON.stringify(row)).not.toContain(SECRET)
    expect(JSON.stringify(await store.list('chat_item'))).not.toContain(PASSWORD)
    store.close()
    const db = new DatabaseSync(join(dir, 'agent.db'))
    const raw = JSON.stringify(db.prepare('SELECT payload FROM rows').all())
    db.close()
    expect(raw).not.toContain(SECRET)
    expect(raw).toContain('[vault:test-key]')
  })
})

describe('vault guard', () => {
  it('fills placeholders for sending tools and scrubs what comes back, activity included', async () => {
    const lines: string[] = []
    const tool = guardTool(echoTool('web_fetch'), vault)
    const out = await tool.run({ url: 'https://api.example.com', headers: { Authorization: 'Bearer {{vault:test-key}}' } }, testContext({ activity: async (text) => (lines.push(text), 0) }))
    expect(out).toContain('Bearer [vault:test-key]')
    expect(out).not.toContain(SECRET)
    expect(lines.join('\n')).not.toContain(SECRET)
  })

  it('does not fill tools that would write it down, nor a call for another device', async () => {
    const memory = guardTool(echoTool('memory_save'), vault)
    expect(await memory.run({ body: 'use {{vault:test-key}}' }, testContext())).toContain('{{vault:test-key}}')
    const elsewhere = guardTool(echoTool('browser_act'), vault)
    expect(await elsewhere.run({ text: '{{vault:test-key}}', device: 'phone' }, testContext())).toContain('{{vault:test-key}}')
  })

  it('an unknown item is a plain error and nothing runs', async () => {
    let ran = false
    const tool = guardTool({ spec: { name: 'web_fetch', description: '', schema: {} }, run: async () => ((ran = true), 'x') }, vault)
    expect(await tool.run({ url: '{{vault:nope}}' }, testContext())).toMatch(/no vault item/i)
    expect(ran).toBe(false)
  })

  it('a real request gets the key in its header; the answer that echoes it comes back scrubbed', async () => {
    let seen = ''
    const server: Server = createServer((req, res) => {
      seen = String(req.headers['authorization'] ?? '')
      res.end(`you sent ${seen}`)
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const port = (server.address() as { port: number }).port
    const fetchTool: Tool = {
      spec: { name: 'browser_fetch', description: '', schema: {} },
      run: async (input) => {
        const res = await fetch(String(input['url']), { headers: input['headers'] as Record<string, string> })
        return `${res.status} ${await res.text()}`
      },
    }
    try {
      const out = await guardTool(fetchTool, vault).run({ url: `http://127.0.0.1:${port}/`, headers: { authorization: 'Bearer {{vault:test-key}}' } }, testContext())
      expect(seen).toBe(`Bearer ${SECRET}`)
      expect(out).toBe('200 you sent Bearer [vault:test-key]')
    } finally {
      server.close()
    }
  })
})

describe('placeholders in shell and code', () => {
  const run = (): VaultRun => ({ env: {}, wroteValue: false, resolve: (raw) => {
    const hit = vault.resolve(raw)
    return 'error' in hit ? hit : { value: hit.value, label: `[vault:${hit.item.ref}]`, env: `VAULT_${hit.item.ref.toUpperCase().replace(/-/g, '_')}_${hit.field.toUpperCase()}` }
  } })

  it('turns a placeholder into an environment variable, quote-aware', () => {
    const r = run()
    const plain = shellCommand(`curl -H 'Authorization: Bearer {{vault:test-key}}' x`, 'posix', r)
    expect('command' in plain && plain.command).toBe(`curl -H 'Authorization: Bearer '"\${VAULT_TEST_KEY_KEY}"'' x`)
    expect(r.env['VAULT_TEST_KEY_KEY']).toBe(SECRET)
    const ps = shellCommand('Invoke-RestMethod -Headers @{ Authorization = "Bearer {{vault:test-key}}" }', 'powershell', run())
    expect('command' in ps && ps.command).toContain('$($env:VAULT_TEST_KEY_KEY)')
    expect(JSON.stringify(ps)).not.toContain(SECRET)
    const cmd = shellCommand('echo {{vault:test-key}}', 'cmd', run())
    expect('command' in cmd && cmd.command).toBe('echo %VAULT_TEST_KEY_KEY%')
  })

  it('code gets a correctly escaped literal', () => {
    const out = codeText('const a = "{{vault:example}}"; const b = {{vault:example}}', run())
    expect('code' in out).toBe(true)
    const code = (out as { code: string }).code
    // eslint-disable-next-line no-new-func
    const value = new Function(`${code}; return [a, b]`)() as string[]
    expect(value).toEqual([PASSWORD, PASSWORD])
  })

  it('shell_run uses the value and nothing it returns or records holds it', async () => {
    const [shell] = guardTools(shellTools({ settings: settingsView({ shell: 'always' }), platform: 'linux' }), vault)
    const input: JsonObject = { command: `printf '%s|%s' '{{vault:test-key}}' "{{vault:example}}" && printf '|%s' {{vault:test-key}} | wc -c` }
    const out = await shell!.run(input, testContext())
    expect(out).toContain('[vault:test-key]|[vault:example]')
    expect(out).not.toContain(SECRET)
    expect(out).not.toContain(PASSWORD)
    expect(out).toContain(String(SECRET.length + 1))
    const record = takeRun(input)
    expect(record?.input).toContain('VAULT_TEST_KEY_KEY')
    expect(JSON.stringify(record)).not.toContain(SECRET)
    expect(JSON.stringify(record)).not.toContain(PASSWORD)
  })

  it('run_code gets the value; the program file does not stay', async () => {
    const tempRoot = mkdtempSync(join(dir, 'code-'))
    const [code] = guardTools(codeTools({ settings: settingsView({ shell: 'always' }), tempRoot }), vault)
    const input: JsonObject = { language: 'javascript', code: 'const k = "{{vault:test-key}}"; console.log(k.length, k)' }
    const out = await code!.run(input, testContext())
    expect(out).toContain(`${SECRET.length} [vault:test-key]`)
    expect(out).not.toContain(SECRET)
    const record = takeRun(input)
    expect(record?.input).toContain('{{vault:test-key}}')
    for (const folder of readdirSync(tempRoot)) expect(readdirSync(join(tempRoot, folder))).not.toContain('main.mjs')
  })
})

describe('vault tools', () => {
  const tools = (): Tool[] => guardTools(vaultTools({ vault }), vault)

  it('vault_list shows names and fields, never values', async () => {
    const out = await toolNamed(tools(), 'vault_list').run({}, testContext())
    expect(out).toContain('test-key')
    expect(out).toContain('fields key')
    expect(out).not.toContain(SECRET)
    expect(out).not.toContain(PASSWORD)
  })

  it('vault_reveal asks first and says no without a yes', async () => {
    const asked: string[] = []
    const reveal = toolNamed(tools(), 'vault_reveal')
    const no = await reveal.run({ item: 'test-key', why: 'debugging' }, testContext({ approve: async (summary) => (asked.push(summary), false) }))
    expect(asked).toHaveLength(1)
    expect(no).not.toContain(SECRET)
    const yes = await reveal.run({ item: 'test-key', why: 'debugging' }, testContext({ approve: async () => true }))
    expect(yes).toContain(SECRET)
    expect(vault.audit().some((entry) => entry.action === 'reveal' && entry.name === 'Test API key')).toBe(true)
  })

  it('a revealable item is shown without asking', async () => {
    const item = vault.list().find((entry) => entry.ref === 'test-key')!
    vault.save({ id: item.id, name: item.name, revealable: true })
    let asked = false
    const out = await toolNamed(tools(), 'vault_reveal').run({ item: 'test-key', why: 'x' }, testContext({ approve: async () => ((asked = true), false) }))
    expect(asked).toBe(false)
    expect(out).toContain(SECRET)
  })

  it('vault_save stores a new secret and its answer does not repeat it', async () => {
    const minted = 'minted-' + randomBytes(10).toString('hex')
    const out = await toolNamed(tools(), 'vault_save').run({ name: 'New site key', kind: 'api_key', fields: { key: minted } }, testContext())
    expect(out).toContain('{{vault:new-site-key}}')
    expect(out).not.toContain(minted)
    const hit = vault.resolve('new-site-key')
    expect('error' in hit ? '' : hit.value).toBe(minted)
  })

  it('vault_fill types the value into the page; what comes back is scrubbed', async () => {
    const typed: string[] = []
    const browser = {
      act: async (request: { text?: string }) => {
        typed.push(request.text ?? '')
        return `Typed into Password. Field now: ${request.text}`
      },
      view: async () => '',
      fix: async () => '',
      snapshotPro: async () => '',
      evaluate: async () => '',
    }
    const fill = toolNamed(guardTools(vaultTools({ vault, browser: browser as never }), vault), 'vault_fill')
    const out = await fill.run({ item: 'example', name: 'Password' }, testContext())
    expect(typed).toEqual([PASSWORD])
    expect(out).not.toContain(PASSWORD)
    expect(out).toContain('[vault:example]')
  })
})

describe('devices', () => {
  it('the whole vault rides in the brain bundle and a newer one replaces the other side', async () => {
    const settingsA = new SettingsStore(join(dir, 'a.json'))
    const kv = new Map<string, string>()
    const local = { localValue: (k: string) => kv.get(k) ?? null, setLocalValue: (k: string, v: string) => void kv.set(k, v) }
    const secretsA = new Secrets(join(dir, 'secrets'), new FileKeyCipher(join(dir, 'secrets.key')))
    const keeper = new BundleKeeper({ settings: settingsA, secrets: secretsA, vault, local })
    {
      const bundle = await keeper.build(true)
      const wire = parseBundle(JSON.parse(JSON.stringify(bundle)))
      expect(wire?.secrets?.vault?.items.length).toBe(2)
      const other = new VaultStore(new Secrets(join(dir, 'other'), new FileKeyCipher(join(dir, 'other.key'))))
      expect(other.replaceAll(wire!.secrets!.vault!)).toBe(true)
      const hit = other.resolve('test-key')
      expect('error' in hit ? '' : hit.value).toBe(SECRET)
      expect(JSON.stringify(await keeper.build(false))).not.toContain(SECRET)
    }
  })
})
