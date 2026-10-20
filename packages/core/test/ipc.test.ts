import { describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS } from '../src/index'

describe('ipc contract', () => {
  it('defaults the shell setting to ask', () => {
    expect(DEFAULT_SETTINGS.shell).toBe('ask')
  })
})
