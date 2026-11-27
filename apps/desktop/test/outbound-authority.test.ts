import { describe, it, expect } from 'vitest'
import { OutboundAuthority, DefiniteSendFailure } from '../src/main/runtime/outbound-authority'

describe('outbound send authority', () => {
  it('sends once for concurrent requests and returns the original result on retry', async () => {
    const authority = new OutboundAuthority()
    let posts = 0
    const send = async () => { posts++; await new Promise((resolve) => setTimeout(resolve, 20)); return 'permalink-1' }
    const [a, b] = await Promise.all([authority.send('turn:target:hash', send), authority.send('turn:target:hash', send)])
    expect(posts).toBe(1)
    expect([a, b, await authority.send('turn:target:hash', send)]).toEqual(['permalink-1', 'permalink-1', 'permalink-1'])
    authority.close()
  })
  it('retries a definite failure and sends distinct content', async () => {
    const authority = new OutboundAuthority()
    await expect(authority.send('one', async () => { throw new DefiniteSendFailure('rejected') })).rejects.toThrow('rejected')
    expect(await authority.send('one', async () => 'first')).toBe('first')
    expect(await authority.send('two', async () => 'second')).toBe('second')
    authority.close()
  })
  it('holds ambiguous outcomes until reconciliation establishes the result or absence', async () => {
    const authority = new OutboundAuthority()
    await expect(authority.send('one', async () => { throw new Error('timeout') })).rejects.toThrow('timeout')
    let count = 0
    const send = async () => { count++; return 'sent' }
    await expect(authority.send('one', send)).rejects.toThrow('reconciliation')
    await expect(authority.send('one', send, async () => ({ status: 'unknown' }))).rejects.toThrow('reconciliation')
    expect(count).toBe(0)
    expect(await authority.send('one', send, async () => ({ status: 'sent', result: 'original' }))).toBe('original')
    expect(count).toBe(0)
    await expect(authority.send('two', async () => { throw new Error('timeout') })).rejects.toThrow()
    expect(await authority.send('two', send, async () => ({ status: 'absent' }))).toBe('sent')
    expect(count).toBe(1)
    authority.close()
  })
})
