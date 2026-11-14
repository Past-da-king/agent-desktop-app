/**
 * S1 (review of 14 Nov 2026): the agent-facing app_update must only ever run an installer that carries a signed release
 * manifest, from a staged copy that is checked again at launch, and only after the person says yes to that exact
 * version, publisher and key. These tests drive the real SelfUpdater with a throwaway test key.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { execFileSync } from 'node:child_process'
import { RELEASE_KEYS, keyFingerprint, verifyRelease } from '../src/main/release-verify'
import { LAUNCHER_PS1, SelfUpdater, type SelfUpdateDeps } from '../src/main/self-update'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-s1-'))
  dirs.push(dir)
  return dir
}

function makeKey(publisher = 'Test Publisher') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ type: 'spki', format: 'der' })
  const fingerprint = createHash('sha256').update(der.subarray(der.length - 32)).digest('hex')
  return { privateKey, release: { id: fingerprint.slice(0, 16), publisher, publicKey: der.toString('base64') }, fingerprint }
}
const KEY = makeKey()
const OTHER = makeKey('Someone Else')

/** Writes `Agent-<v>-setup.exe` and, when `signer` is given, its signed manifest next to it. */
function release(dir: string, version: string, opts: { signer?: ReturnType<typeof makeKey> | null; body?: string; override?: Record<string, unknown>; publisher?: string } = {}): string {
  const file = `Agent-${version}-setup.exe`
  const path = join(dir, file)
  const body = opts.body ?? `MZ-installer-${version}`
  writeFileSync(path, body)
  const signer = opts.signer === undefined ? KEY : opts.signer
  if (signer !== null) {
    const payload = JSON.stringify({
      product: 'Agent', version, file, size: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex'),
      publisher: opts.publisher ?? signer.release.publisher, commit: 'abc1234def', createdAt: '2026-11-14T00:00:00Z', ...(opts.override ?? {}),
    })
    writeFileSync(`${path}.release.json`, JSON.stringify({ format: 1, payload, keyId: signer.release.id, signature: sign(null, Buffer.from(payload), signer.privateKey).toString('base64') }))
  }
  return path
}

function fakeStart(started: string[]): (commandLine: string) => Promise<number> {
  return async (commandLine) => {
    started.push(commandLine)
    const watchdog = / -Role watchdog$/.test(commandLine)
    const params = /"([^"]+params\.json)"/.exec(commandLine)?.[1]
    if (params !== undefined) appendFileSync((JSON.parse(readFileSync(params, 'utf8')) as { log: string }).log, watchdog ? 'x [watchdog] watchdog running pid 2\n' : 'x [launcher] launcher running pid 1\n')
    return watchdog ? 4322 : 4321
  }
}

function rig(patch: Partial<SelfUpdateDeps> = {}) {
  const dir = temp()
  const started: string[] = []
  const quits: number[] = []
  const told: string[] = []
  const busy = { on: true }
  const asked: Array<{ summary: string; details: string | undefined }> = []
  const answer = { yes: true }
  const updater = new SelfUpdater({
    userData: dir, currentVersion: '0.2.52', productName: 'Agent', execPath: join(dir, 'app', 'Agent.exe'), platform: 'win32', packaged: true,
    busy: () => busy.on, startLauncher: fakeStart(started), quit: () => void quits.push(1), tell: (_c, t) => void told.push(t),
    pid: 999_999, pollMs: 5, launcherReadyMs: 300, releaseKeys: [KEY.release], ...patch,
  } as SelfUpdateDeps)
  const install = (path: string, chat = 'main') =>
    (updater.install as unknown as (p: string, c: string, a: (s: string, d?: string) => Promise<boolean>) => Promise<{ ok: boolean; text: string }>)(path, chat, async (summary, details) => {
      asked.push({ summary, details })
      return answer.yes
    })
  return { updater, install, dir, started, quits, told, busy, asked, answer }
}
async function until(check: () => boolean, ms = 3000): Promise<void> {
  for (let w = 0; w < ms && !check(); w += 10) await new Promise((r) => setTimeout(r, 10))
}
function stagedFile(dir: string): string {
  const root = join(dir, 'update-staging')
  const sub = readdirSync(root)[0]!
  return join(root, sub, readdirSync(join(root, sub))[0]!)
}

describe('app_update: only a signed, confirmed release is ever installed', () => {
  it('S1-01 refuses an installer with no signed manifest (unsigned)', async () => {
    const r = rig()
    const res = await r.install(release(r.dir, '0.2.53', { signer: null }))
    expect(res.ok).toBe(false)
    expect(res.text).toMatch(/no signed release manifest/)
    expect(r.asked).toEqual([])
    expect(existsSync(join(r.dir, 'update-pending.json'))).toBe(false)
  })

  it('S1-02 refuses a file whose bytes changed after it was signed (digest mismatch)', async () => {
    const r = rig()
    const path = release(r.dir, '0.2.53')
    writeFileSync(path, 'MZ-installer-0.2.53-with-malware')
    const res = await r.install(path)
    expect(res.ok).toBe(false)
    expect(res.text).toMatch(/changed after it was signed/)
    expect(r.asked).toEqual([])
  })

  it('S1-03 refuses same-size different bytes (sha256 mismatch, not just size)', async () => {
    const r = rig()
    const path = release(r.dir, '0.2.53', { body: 'AAAAAAAA' })
    writeFileSync(path, 'BBBBBBBB')
    const res = await r.install(path)
    expect(res.ok).toBe(false)
    expect(res.text).toMatch(/sha256/)
  })

  it('S1-04 refuses a manifest signed by a key the app does not trust', async () => {
    const r = rig()
    const res = await r.install(release(r.dir, '0.2.53', { signer: OTHER }))
    expect(res.ok).toBe(false)
    expect(res.text).toMatch(/does not trust/)
    expect(r.asked).toEqual([])
  })

  it('S1-05 refuses a manifest whose payload was edited after signing (bad signature)', async () => {
    const r = rig()
    const path = release(r.dir, '0.2.53')
    const m = JSON.parse(readFileSync(`${path}.release.json`, 'utf8')) as { payload: string }
    m.payload = m.payload.replace('abc1234def', 'ffffffffff')
    writeFileSync(`${path}.release.json`, JSON.stringify(m))
    const res = await r.install(path)
    expect(res.ok).toBe(false)
    expect(res.text).toMatch(/signature .* not valid/)
  })

  it('S1-06 refuses a publisher name the signing key does not own, and a manifest signed for another file or version', async () => {
    const r = rig()
    expect((await r.install(release(r.dir, '0.2.53', { publisher: 'Microsoft' }))).text).toMatch(/belongs to "Test Publisher"/)
    expect((await r.install(release(r.dir, '0.2.54', { override: { version: '0.2.99' } }))).text).toMatch(/signed for version 0\.2\.99/)
    expect((await r.install(release(r.dir, '0.2.55', { override: { file: 'Agent-0.2.54-setup.exe' } }))).text).toMatch(/signed for Agent-0\.2\.54-setup\.exe/)
    expect(r.asked).toEqual([])
  })

  it('S1-07 refuses older and equal versions even when signed', async () => {
    const r = rig()
    expect((await r.install(release(r.dir, '0.2.40'))).text).toMatch(/older/)
    const same = await r.install(release(r.dir, '0.2.52'))
    expect(same.ok).toBe(false)
    expect(same.text).toMatch(/already running|not newer|same version/)
    expect(r.asked).toEqual([])
  })

  it('S1-08 raises an approval card with version, verified publisher, key fingerprint and short sha256, and does nothing without a yes', async () => {
    const r = rig()
    r.answer.yes = false
    const path = release(r.dir, '0.2.53')
    const res = await r.install(path)
    expect(res.ok).toBe(false)
    expect(res.text).toMatch(/did not approve|said no|not installed/i)
    expect(r.asked).toHaveLength(1)
    const sha = createHash('sha256').update('MZ-installer-0.2.53').digest('hex')
    expect(r.asked[0]!.summary).toBe(`Install Agent 0.2.53, verified publisher Test Publisher, key ${(KEY.fingerprint.slice(0, 16).match(/.{4}/g) ?? []).join(' ')}, sha256 ${sha.slice(0, 12)}`)
    expect(r.asked[0]!.details).toContain(sha)
    r.busy.on = false
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(r.started).toEqual([])
    expect(r.quits).toEqual([])
    expect(existsSync(join(r.dir, 'update-pending.json'))).toBe(false)
    // Declined: nothing staged is left behind.
    expect(existsSync(join(r.dir, 'update-staging')) ? readdirSync(join(r.dir, 'update-staging')) : []).toEqual([])
  })

  it('S1-09 happy path: yes runs the STAGED copy (not the original), with its digest on the launcher command line and in the parameters', async () => {
    const r = rig()
    const path = release(r.dir, '0.2.53')
    const res = await r.install(path, 'chat_1')
    expect(res.ok).toBe(true)
    r.busy.on = false
    await until(() => r.quits.length > 0)
    expect(r.quits).toHaveLength(1)
    const sha = createHash('sha256').update('MZ-installer-0.2.53').digest('hex')
    expect(r.started).toHaveLength(2)
    const params = JSON.parse(readFileSync(/"([^"]+params\.json)"/.exec(r.started[0]!)![1]!, 'utf8')) as { installer: string; installerSha256: string; installerSize: number }
    expect(params.installer).toBe(stagedFile(r.dir))
    expect(params.installer).not.toBe(path)
    expect(params.installer.startsWith(join(r.dir, 'update-staging'))).toBe(true)
    expect(params.installerSha256).toBe(sha)
    expect(r.started[0]).toContain(`-ExpectSha256 ${sha}`)
    expect(r.started[1]).toMatch(new RegExp(`-ExpectSha256 ${sha} -Role watchdog$`))
    expect(readFileSync(params.installer, 'utf8')).toBe('MZ-installer-0.2.53')
  })

  it('S1-10 swapping the file in Downloads after the check changes nothing: the verified staged copy is what runs', async () => {
    const r = rig()
    const path = release(r.dir, '0.2.53')
    expect((await r.install(path)).ok).toBe(true)
    writeFileSync(path, 'MZ-evil')
    r.busy.on = false
    await until(() => r.quits.length > 0)
    expect(r.quits).toHaveLength(1)
    expect(readFileSync(stagedFile(r.dir), 'utf8')).toBe('MZ-installer-0.2.53')
  })

  it('S1-11 a staged file swapped after verification is refused at launch: no launcher, no quit, the chat is told', async () => {
    const r = rig()
    expect((await r.install(release(r.dir, '0.2.53'), 'chat_9')).ok).toBe(true)
    writeFileSync(stagedFile(r.dir), 'MZ-swapped-after-check')
    r.busy.on = false
    await until(() => r.told.length > 0)
    expect(r.started).toEqual([])
    expect(r.quits).toEqual([])
    expect(r.told[0]).toMatch(/changed after it was checked/)
    expect(r.told[0]).toContain('still on 0.2.52')
    expect(existsSync(join(r.dir, 'update-pending.json'))).toBe(false)
  })

  it('S1-12 the launcher script itself hashes the installer right before starting it and refuses a mismatch', () => {
    const script = LAUNCHER_PS1
    expect(script).toContain('ComputeHash')
    expect(script).toContain('ExpectSha256')
    expect(script).toContain('installerSha256')
    // The last check holds a no-write handle, comes after the last preparation step and before the process is started.
    const last = script.indexOf('$hold = OpenVerified')
    expect(last).toBeGreaterThan(script.indexOf("Stage 'running the installer'"))
    expect(last).toBeLessThan(script.indexOf('$proc = [Diagnostics.Process]::Start($psi)'))
    expect(script).toContain("'Open', 'Read', 'Read'")
    // A launcher given no digest refuses to run anything.
    expect(script).toMatch(/no installer digest/)
  })

  it('S1-13 the build and test environment does not leak the private key: no private key material in the repo sources', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'main', 'release-verify.ts'), 'utf8')
    expect(src).not.toMatch(/BEGIN (EC |OPENSSH )?PRIVATE KEY/)
    expect(src).toMatch(/RELEASE_KEYS/)
  })

  it('S1-14 the pinned release keys are well formed: id is the fingerprint prefix, a publisher is named, rotation list non-empty', () => {
    expect(RELEASE_KEYS.length).toBeGreaterThan(0)
    for (const key of RELEASE_KEYS) {
      expect(key.id).toBe(keyFingerprint(key).slice(0, 16))
      expect(key.publisher).not.toBe('')
    }
    expect(new Set(RELEASE_KEYS.map((k) => k.id)).size).toBe(RELEASE_KEYS.length)
  })

  it('S1-15 tools/release/sign-release.mjs signs an installer the app verifies, and the app refuses it once a byte changes', async () => {
    const dir = temp()
    const script = join(__dirname, '..', '..', '..', 'tools', 'release', 'sign-release.mjs')
    const keyFile = join(dir, 'k', 'ed25519.key')
    const gen = JSON.parse(execFileSync(process.execPath, [script, 'keygen', '--out', keyFile], { encoding: 'utf8' })) as { keyId: string; publicKeySpkiBase64: string }
    const path = join(dir, 'Agent-0.2.60-setup.exe')
    writeFileSync(path, 'MZ-real-installer-bytes')
    const out = JSON.parse(execFileSync(process.execPath, [script, 'sign', '--installer', path, '--commit', 'abc1234def', '--key', keyFile, '--publisher', 'Test Publisher'], { encoding: 'utf8' })) as { sha256: string; keyId: string }
    expect(out.keyId).toBe(gen.keyId)
    const keys = [{ id: gen.keyId, publisher: 'Test Publisher', publicKey: gen.publicKeySpkiBase64 }]
    const good = await verifyRelease(path, { product: 'Agent', version: '0.2.60', keys })
    expect(good).toMatchObject({ ok: true, release: { version: '0.2.60', sha256: out.sha256, commit: 'abc1234def' } })
    // The script also verifies its own output with the public half.
    const pub = join(dir, 'pub.b64')
    writeFileSync(pub, gen.publicKeySpkiBase64)
    expect(execFileSync(process.execPath, [script, 'verify', '--installer', path, '--pub', pub], { encoding: 'utf8' })).toMatch(/^ok:/)
    // keygen never overwrites a release key.
    expect(() => execFileSync(process.execPath, [script, 'keygen', '--out', keyFile], { stdio: 'pipe' })).toThrow()
    writeFileSync(path, 'MZ-real-installer-bytez')
    expect((await verifyRelease(path, { product: 'Agent', version: '0.2.60', keys })).ok).toBe(false)
    // The shipped keys do not trust a manifest from this throwaway key.
    writeFileSync(path, 'MZ-real-installer-bytes')
    expect((await verifyRelease(path, { product: 'Agent', version: '0.2.60' })).ok).toBe(false)
  })
})
