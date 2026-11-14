/**
 * Trust for the app's own updater: an installer is only ever run when a signed release manifest sits next to it
 * (`Agent-<version>-setup.exe.release.json`, written by tools/release/sign-release.mjs over the finished installer)
 * and every claim in it holds for the exact bytes about to run.
 *
 * The manifest is `{ format: 1, payload, keyId, signature }`: `payload` is JSON text (product, version, file, size,
 * sha256, publisher, commit, createdAt) and `signature` is an Ed25519 signature over that text's UTF-8 bytes. The
 * public keys that may sign sit in RELEASE_KEYS below (a list, so a key can be rotated: add the new one, ship, retire
 * the old one). The private key is never in the repo or the app (docs/release/signing.md).
 *
 * Staging: a verified installer is copied into the app's own folder under userData and the copy is hashed against
 * the signed sha256; only the staged copy is ever started, and the launcher hashes it once more immediately before it
 * starts it (self-update.ts), so a file swapped between the check and the launch is refused.
 */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface ReleaseKey {
  /** First 16 hex characters of the key's fingerprint. */
  id: string
  /** Who this key speaks for: a manifest signed by it must name exactly this publisher. */
  publisher: string
  /** The public key, SPKI DER, base64. */
  publicKey: string
}

/**
 * The release keys this app trusts (pinned in source; the update path never reads a key from anywhere else).
 * To rotate: add the new key here, release a build signed with the OLD key that carries it, then sign with the new
 * key and, later, drop the old one.
 */
export const RELEASE_KEYS: ReleaseKey[] = [
  {
    id: '73fe5d2e79848263',
    publisher: 'Ayanda Phaketsi',
    publicKey: 'MCowBQYDK2VwAyEABbBE/FVxUXT87ApC5xv+clmTh+p9p+oeraM/I76QZ78=',
  },
]

export interface ReleasePayload {
  product: string
  version: string
  file: string
  size: number
  sha256: string
  publisher: string
  commit: string
  createdAt: string
}

export interface VerifiedRelease {
  version: string
  file: string
  size: number
  sha256: string
  publisher: string
  commit: string
  keyId: string
  /** The key's fingerprint, grouped for people: `73fe 5d2e 7984 8263`. */
  fingerprint: string
}

export type Verification = { ok: true; release: VerifiedRelease } | { ok: false; reason: string }

export function manifestPath(installer: string): string {
  return `${installer}.release.json`
}

/** sha256 of a file, streamed. */
export function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** The fingerprint of a pinned key: sha256 of its raw 32 bytes. */
export function keyFingerprint(key: ReleaseKey): string {
  const der = Buffer.from(key.publicKey, 'base64')
  return createHash('sha256').update(der.subarray(der.length - 32)).digest('hex')
}

export function groupFingerprint(fingerprint: string): string {
  return (fingerprint.slice(0, 16).match(/.{4}/g) ?? []).join(' ')
}

function isPayload(value: unknown): value is ReleasePayload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['product'] === 'string' &&
    typeof v['version'] === 'string' &&
    typeof v['file'] === 'string' &&
    typeof v['size'] === 'number' &&
    Number.isFinite(v['size']) &&
    typeof v['sha256'] === 'string' &&
    /^[0-9a-f]{64}$/.test(v['sha256']) &&
    typeof v['publisher'] === 'string' &&
    v['publisher'] !== '' &&
    typeof v['commit'] === 'string' &&
    /^[0-9a-f]{7,40}$/.test(v['commit']) &&
    typeof v['createdAt'] === 'string'
  )
}

/**
 * Checks the signed manifest for `installer` against the pinned keys and the file itself.
 * `expectedVersion` is the version the file name claims; the signed version must be the same.
 */
export async function verifyRelease(
  installer: string,
  opts: { product: string; version: string; keys?: ReleaseKey[] },
): Promise<Verification> {
  const keys = opts.keys ?? RELEASE_KEYS
  const name = basename(installer)
  const mfile = manifestPath(installer)
  if (!existsSync(mfile)) return { ok: false, reason: `${name} has no signed release manifest (${basename(mfile)} next to it), so it is not a verified release and was not installed.` }
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(mfile, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>
  } catch {
    return { ok: false, reason: `${basename(mfile)} is not readable JSON, so ${name} is not a verified release.` }
  }
  if (manifest['format'] !== 1 || typeof manifest['payload'] !== 'string' || typeof manifest['signature'] !== 'string' || typeof manifest['keyId'] !== 'string') {
    return { ok: false, reason: `${basename(mfile)} is not a release manifest this app understands.` }
  }
  const key = keys.find((k) => k.id === manifest['keyId'])
  if (key === undefined) return { ok: false, reason: `${name} is signed with key ${String(manifest['keyId'])}, which this app does not trust. It was not installed.` }
  let valid = false
  try {
    valid = verify(
      null,
      Buffer.from(manifest['payload'], 'utf8'),
      createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' }),
      Buffer.from(manifest['signature'], 'base64'),
    )
  } catch {
    valid = false
  }
  if (!valid) return { ok: false, reason: `The signature on ${basename(mfile)} is not valid for key ${key.id}: the manifest was changed or was not signed by this publisher. Nothing was installed.` }
  let payload: unknown
  try {
    payload = JSON.parse(manifest['payload'])
  } catch {
    return { ok: false, reason: `${basename(mfile)} carries a payload that is not JSON.` }
  }
  if (!isPayload(payload)) return { ok: false, reason: `${basename(mfile)} is missing fields that a release manifest must carry.` }
  if (payload.product !== opts.product) return { ok: false, reason: `${name} is signed for "${payload.product}", not ${opts.product}.` }
  if (payload.publisher !== key.publisher) return { ok: false, reason: `The manifest names publisher "${payload.publisher}" but key ${key.id} belongs to "${key.publisher}". Nothing was installed.` }
  if (payload.file !== name) return { ok: false, reason: `The manifest was signed for ${payload.file}, not ${name}.` }
  if (payload.version !== opts.version) return { ok: false, reason: `The manifest was signed for version ${payload.version} but the file is named for ${opts.version}.` }
  let size: number
  try {
    size = statSync(installer).size
  } catch {
    return { ok: false, reason: `There is no file at ${installer}.` }
  }
  if (size !== payload.size) return { ok: false, reason: `${name} is ${size} bytes but the signed release says ${payload.size}: the file was changed after it was signed. Nothing was installed.` }
  const digest = await sha256OfFile(installer)
  if (digest !== payload.sha256) return { ok: false, reason: `${name} does not match its signed sha256 (it is ${digest.slice(0, 12)}, signed ${payload.sha256.slice(0, 12)}): the file was changed after it was signed. Nothing was installed.` }
  return {
    ok: true,
    release: {
      version: payload.version,
      file: payload.file,
      size: payload.size,
      sha256: payload.sha256,
      publisher: payload.publisher,
      commit: payload.commit,
      keyId: key.id,
      fingerprint: groupFingerprint(keyFingerprint(key)),
    },
  }
}

/** Copies a verified installer into `<root>/<version>-<time>/` and checks the copy against the signed digest. */
export async function stageInstaller(
  installer: string,
  release: VerifiedRelease,
  root: string,
  time: number,
  keep = 2,
): Promise<{ ok: true; path: string; dir: string } | { ok: false; reason: string }> {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    pruneStaged(root, keep)
    const dir = join(root, `${release.version}-${time}`)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, release.file)
    copyFileSync(installer, path)
    const staged = await verifyStaged(path, release)
    if (!staged.ok) {
      rmSync(dir, { recursive: true, force: true })
      return staged
    }
    return { ok: true, path, dir }
  } catch (error) {
    return { ok: false, reason: `Could not stage the installer: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** The staged copy still is the signed file (size and sha256). */
export async function verifyStaged(path: string, release: Pick<VerifiedRelease, 'sha256' | 'size' | 'file'>): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const size = statSync(path).size
    if (size !== release.size) return { ok: false, reason: `The staged installer is ${size} bytes, the signed release says ${release.size}: it was changed after it was checked. Nothing was installed.` }
    const digest = await sha256OfFile(path)
    if (digest !== release.sha256) return { ok: false, reason: `The staged installer no longer matches its signed sha256 (${digest.slice(0, 12)} instead of ${release.sha256.slice(0, 12)}): it was changed after it was checked. Nothing was installed.` }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `The staged installer could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Keeps the newest `keep` staged folders (the one about to be made counts as one of them, so keep one fewer). */
function pruneStaged(root: string, keep: number): void {
  try {
    const dirs = readdirSync(root)
      .map((name) => ({ name, at: statSync(join(root, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    for (const old of dirs.slice(Math.max(0, keep - 1))) rmSync(join(root, old.name), { recursive: true, force: true })
  } catch {
    // Best effort.
  }
}

/** What the person is asked: exact version, verified publisher, key fingerprint, short sha256. */
export function confirmationText(from: string, release: VerifiedRelease): { summary: string; details: string } {
  return {
    summary: `Install Agent ${release.version}, verified publisher ${release.publisher}, key ${release.fingerprint}, sha256 ${release.sha256.slice(0, 12)}`,
    details:
      `Update Agent ${from} -> ${release.version}\n` +
      `Publisher (signed): ${release.publisher}\n` +
      `Signing key: ${release.keyId} (fingerprint ${release.fingerprint})\n` +
      `sha256: ${release.sha256}\n` +
      `Size: ${release.size} bytes\n` +
      `Built from commit: ${release.commit}\n` +
      'The app closes, installs silently in the same place and opens again.',
  }
}
