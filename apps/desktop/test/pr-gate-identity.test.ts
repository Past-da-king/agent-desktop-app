import { expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@agent/core'
import { Store } from '../src/main/db'
import { PrGate, ATTESTATION_FIELDS } from '../src/main/runtime/pr-gate'
import { testContext } from './support'
it('rejects the calling helper bare id as well as its qualified owner id', async () => {
  const store = new Store(':memory:')
  try {
    const gate = new PrGate(store, () => ({
      ...DEFAULT_SETTINGS,
      prGateEnabled: true,
    }))
    const ctx = testContext({
      owner: 'helper:author-uuid',
      agentLabel: 'Build agent',
      chat: 'project',
    })
    const held = await gate.check(
      'shell_run',
      { command: 'gh pr ready 3' },
      ctx,
    )
    const id = held!.match(/Gate id: ([a-f0-9-]+)/)![1]!
    const fields = Object.fromEntries(
      ATTESTATION_FIELDS.map((key) => [
        key,
        key === 'reviewerAgentId'
          ? 'author-uuid'
          : 'Specific evidence at /tmp/review.md for ' + key,
      ]),
    )
    expect(await gate.attest(id, fields, ctx)).toContain('Refused')
  } finally {
    store.close()
  }
})
