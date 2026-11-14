#!/usr/bin/env node
/**
 * Signs a finished Agent installer so the app's own updater (apps/desktop/src/main/release-verify.ts) accepts it.
 * Run it ONCE over the finished `Agent-<version>-setup.exe` as the last step of a release (docs/release/signing.md).
 *
 *   node tools/release/sign-release.mjs keygen  --out <private-key.pem>            make a release keypair (prints the public half)
 *   node tools/release/sign-release.mjs sign    --installer <Agent-x.y.z-setup.exe> --commit <git sha>
 *                                               [--key <private-key.pem>] [--publisher "Name"] [--out <manifest.json>]
 *   node tools/release/sign-release.mjs verify  --installer <Agent-x.y.z-setup.exe> --pub <public-key.spki.b64>
 *   node tools/release/sign-release.mjs fingerprint --key <private-key.pem>
 *
 * The private key is read from --key, else the file named by AGENT_RELEASE_KEY_FILE, else
 * ~/.config/agent-release/ed25519.key. It never lives in the repo and the app never sees it.
 * The manifest `<installer>.release.json` is written next to the installer:
 *   { format: 1, payload: "<JSON text>", keyId, signature: "<base64 Ed25519 over the payload's UTF-8 bytes>" }
 * where the payload holds product, version, file, size, sha256, publisher, commit and createdAt.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const PRODUCT = 'Agent'
const DEFAULT_PUBLISHER = 'Ayanda Phaketsi'

function fail(message) {
  console.error(`sign-release: ${message}`)
  process.exit(1)
}

function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : 'true'
    out[a.slice(2)] = value
  }
  return out
}

/** The raw 32 bytes of an Ed25519 public key (the tail of its SPKI DER). */
function rawPublic(spkiDer) {
  return spkiDer.subarray(spkiDer.length - 32)
}

function describeKey(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' })
  const fingerprint = createHash('sha256').update(rawPublic(der)).digest('hex')
  return { spkiBase64: der.toString('base64'), fingerprint, keyId: fingerprint.slice(0, 16) }
}

function loadPrivate(path) {
  const file = path ?? process.env['AGENT_RELEASE_KEY_FILE'] ?? join(homedir(), '.config', 'agent-release', 'ed25519.key')
  if (!existsSync(file)) fail(`no private key at ${file} (use --key, or AGENT_RELEASE_KEY_FILE)`)
  return createPrivateKey(readFileSync(file, 'utf8'))
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function versionOf(file) {
  const m = new RegExp(`^${PRODUCT}-(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?)-setup\\.exe$`, 'i').exec(basename(file))
  if (m === null) fail(`${basename(file)} is not named ${PRODUCT}-<version>-setup.exe`)
  return m[1]
}

const [command, ...rest] = process.argv.slice(2)
const opt = args(rest)

if (command === 'keygen') {
  const out = opt['out'] ?? fail('keygen needs --out <private-key.pem>')
  if (existsSync(out)) fail(`${out} already exists: refusing to overwrite a release key`)
  mkdirSync(dirname(resolve(out)), { recursive: true })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  try {
    chmodSync(out, 0o600)
  } catch {
    // Not every file system has modes.
  }
  const k = describeKey(publicKey)
  console.log(JSON.stringify({ keyId: k.keyId, fingerprint: k.fingerprint, publicKeySpkiBase64: k.spkiBase64, privateKeyFile: out }, null, 2))
} else if (command === 'fingerprint') {
  const k = describeKey(createPublicKey(loadPrivate(opt['key'])))
  console.log(JSON.stringify({ keyId: k.keyId, fingerprint: k.fingerprint, publicKeySpkiBase64: k.spkiBase64 }, null, 2))
} else if (command === 'sign') {
  const installer = opt['installer'] ?? fail('sign needs --installer <file>')
  const commit = opt['commit'] ?? fail('sign needs --commit <git sha the installer was built from>')
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) fail('--commit must be a git sha (7 to 40 hex characters)')
  if (!existsSync(installer) || !statSync(installer).isFile()) fail(`no file at ${installer}`)
  const priv = loadPrivate(opt['key'])
  const k = describeKey(createPublicKey(priv))
  const payload = JSON.stringify({
    product: PRODUCT,
    version: versionOf(installer),
    file: basename(installer),
    size: statSync(installer).size,
    sha256: sha256File(installer),
    publisher: opt['publisher'] ?? DEFAULT_PUBLISHER,
    commit: commit.toLowerCase(),
    createdAt: new Date().toISOString(),
  })
  const signature = sign(null, Buffer.from(payload, 'utf8'), priv).toString('base64')
  const manifest = { format: 1, payload, keyId: k.keyId, signature }
  const out = opt['out'] ?? `${installer}.release.json`
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  // Prove it before handing it on: verify what was just written with the public half.
  const back = JSON.parse(readFileSync(out, 'utf8'))
  if (!verify(null, Buffer.from(back.payload, 'utf8'), createPublicKey(priv), Buffer.from(back.signature, 'base64'))) fail('the signature written does not verify')
  console.log(JSON.stringify({ manifest: out, keyId: k.keyId, fingerprint: k.fingerprint, ...JSON.parse(payload) }, null, 2))
} else if (command === 'verify') {
  const installer = opt['installer'] ?? fail('verify needs --installer <file>')
  const pubFile = opt['pub'] ?? fail('verify needs --pub <file holding the public key, base64 SPKI DER>')
  const manifestFile = opt['manifest'] ?? `${installer}.release.json`
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const pub = createPublicKey({ key: Buffer.from(readFileSync(pubFile, 'utf8').trim(), 'base64'), format: 'der', type: 'spki' })
  if (!verify(null, Buffer.from(manifest.payload, 'utf8'), pub, Buffer.from(manifest.signature, 'base64'))) fail('the signature does not verify')
  const payload = JSON.parse(manifest.payload)
  if (payload.sha256 !== sha256File(installer)) fail('the installer does not match the signed sha256')
  if (payload.size !== statSync(installer).size) fail('the installer does not match the signed size')
  console.log(`ok: ${payload.file} ${payload.version} sha256 ${payload.sha256.slice(0, 12)} commit ${payload.commit}`)
} else {
  fail('usage: sign-release.mjs keygen|sign|verify|fingerprint (see the header of this file)')
}
