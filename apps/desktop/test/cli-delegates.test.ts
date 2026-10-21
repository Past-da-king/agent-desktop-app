import { describe, expect, it } from 'vitest'

import { threadDelegates } from '../src/main/runtime/cli-host'

// A project chat is its project's main agent: on a plan it must keep delegate and the helper controls,
// or every hand-off turns into a new project chat (bug found 22 Oct 2026).
describe('which plan threads may hand work to helpers', () => {
  it('the main thread and project chats can', () => {
    expect(threadDelegates('main')).toBe(true)
    expect(threadDelegates('pcb122cbf469234956')).toBe(true)
    expect(threadDelegates('c7d4d6545f3f94e8b')).toBe(true)
  })

  it('helpers and routines cannot', () => {
    expect(threadDelegates('helper:abc123')).toBe(false)
    expect(threadDelegates('routine')).toBe(false)
  })
})
