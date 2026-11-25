import { randomBytes } from 'node:crypto'

export const PR_GATE_KEY = 'prGateTransportKey'
export interface PrGateSecrets {
  get(name: string): string | null
  set(name: string, value: string): void
}
// Only used by isolated toolsets without a secrets service, such as test fixtures.
const processKey = randomBytes(32).toString('hex')
export function prGateKey(secrets?: PrGateSecrets): string {
  if (!secrets) return processKey
  const old = secrets.get(PR_GATE_KEY)
  if (old && /^[a-f0-9]{64}$/.test(old)) return old
  const key = randomBytes(32).toString('hex')
  secrets.set(PR_GATE_KEY, key)
  return key
}
