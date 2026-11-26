import { describe, expect, it } from 'vitest'
import { HUMAN_DEADLINE_MS, DEFAULT_DEADLINE_MS, deadlineFor } from '../src/main/devices/device-tools'

// 26 Nov 2026: the phone answered "The phone didn't finish request_approval in time." after exactly two minutes while
// he was using it: a question to a person got the same 120 s limit as a machine call. A person gets ten minutes.
describe('how long a device tool may take', () => {
  it('gives a question or approval to a person the same ten minutes the phone itself waits', () => {
    for (const tool of ['request_approval', 'ask_user', 'browser_handoff']) {
      expect(deadlineFor(tool, tool === 'browser_handoff' ? 'browser' : 'approval')).toBe(HUMAN_DEADLINE_MS)
    }
    expect(HUMAN_DEADLINE_MS).toBe(600_000)
  })
  it('keeps machine calls short and the browser long', () => {
    expect(deadlineFor('notify_user', 'notifications')).toBe(DEFAULT_DEADLINE_MS)
    expect(deadlineFor('browser_open', 'browser')).toBe(600_000)
  })
})
