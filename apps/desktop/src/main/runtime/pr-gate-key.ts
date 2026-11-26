import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  createHash,
} from 'node:crypto'
// This is a storage name, not signing material.
export const PR_GATE_KEY = 'prGateSigningKeyV2' // gitleaks:allow -- storage identifier, not key material
export interface PrGateSecrets {
  get(name: string): string | null
  set(name: string, value: string): void
}
function generate(): string {
  return generateKeyPairSync('ed25519')
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString()
}
const processKey = generate()
export function prGateKey(secrets?: PrGateSecrets): string {
  if (!secrets) return processKey
  const old = secrets.get(PR_GATE_KEY)
  if (old) {
    try {
      if (createPrivateKey(old).asymmetricKeyType === 'ed25519') return old
    } catch {}
  }
  const key = generate()
  secrets.set(PR_GATE_KEY, key)
  return key
}
// Hex seeds remain supported only for isolated deterministic fixtures, never persisted by the app.
export function privateKey(key: string) {
  return /^[a-f0-9]{64}$/.test(key)
    ? createPrivateKey({
        key: Buffer.concat([
          Buffer.from('302e020100300506032b657004220420', 'hex'),
          Buffer.from(key, 'hex'),
        ]),
        format: 'der',
        type: 'pkcs8',
      })
    : createPrivateKey(key)
}
export function publicKey(key: string): string {
  return createPublicKey(privateKey(key))
    .export({ format: 'pem', type: 'spki' })
    .toString()
}
export function keyId(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function newPrGateKey(secrets: PrGateSecrets): string {
  const key = generate()
  secrets.set(PR_GATE_KEY, key)
  return key
}
