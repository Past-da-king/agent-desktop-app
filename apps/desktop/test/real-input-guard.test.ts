import { describe, expect, it } from 'vitest'

import { realInputUse, refuseRealInput, REAL_INPUT_NAMES } from '../src/main/agent-cursor/real-input-guard'

describe('real input guard', () => {
  it.each(REAL_INPUT_NAMES.map((name) => [name]))('refuses %s', (name) => {
    expect(realInputUse('powershell -c "[x]::' + name + '(1,2)"')).toBe(name)
  })
  it('is case-insensitive and whole-word', () => {
    expect(realInputUse('add-type ... setcursorpos')).toBe('setcursorpos')
    expect(realInputUse('MySendInputHelper()')).toBeNull()
  })
  it('lets a command that only reads files name them', () => {
    expect(realInputUse('grep -rn SendInput src/')).toBeNull()
    expect(realInputUse('rg keybd_event')).toBeNull()
    expect(realInputUse('grep x | powershell -c "SendKeys"')).toBe('SendKeys')
  })
  it('points to screen_act', () => {
    const message = refuseRealInput('[System.Windows.Forms.SendKeys]::SendWait("a")')
    expect(message).toContain('screen_act')
    expect(message).toContain('SendKeys')
  })
  it('lets ordinary commands run', () => {
    expect(refuseRealInput('git status')).toBeNull()
    expect(refuseRealInput('')).toBeNull()
  })
})
