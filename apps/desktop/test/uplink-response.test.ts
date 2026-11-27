import { describe, it, expect } from 'vitest'
import { Uplink, AuthorityUnreachableError } from '../src/main/devices/uplink'

describe('uplink request response', () => {
  it('correlates results and refuses disconnected calls', async () => {
    const u = new Uplink({ target: () => null, pass: () => '', facts: () => ({} as never), runTool: async () => ({ ok: false, error: '' }) })
    await expect(u.rpcCall('outbound.claim', [])).rejects.toBeInstanceOf(AuthorityUnreachableError)
    const frames: Array<Record<string, unknown>> = []
    const internals = u as unknown as { conn: unknown; onText(s: string): Promise<void> }
    internals.conn = { isOpen: true, sendText: (s: string) => frames.push(JSON.parse(s)) }
    const pending = u.rpcCall('outbound.claim', ['hash'])
    expect(frames[0]).toMatchObject({ type: 'call', method: 'outbound.claim', args: ['hash'] })
    await internals.onText(JSON.stringify({ type: 'result', id: frames[0]?.['id'], ok: true, value: 'granted' }))
    expect(await pending).toBe('granted')
    await expect(u.rpcCall('outbound.claim', [], 2)).rejects.toBeInstanceOf(AuthorityUnreachableError)
  })
})
