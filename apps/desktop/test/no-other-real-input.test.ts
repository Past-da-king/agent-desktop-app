import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import { NO_REAL_INPUT } from '../src/main/runtime/prompt'
import { REAL_INPUT_NAMES } from '../src/main/agent-cursor/real-input-guard'

const ROOT = join(__dirname, '..', '..', '..')
const WORDS = /(?<![A-Za-z0-9_])(SetCursorPos|mouse_event|keybd_event|SendInput|SendKeys|SetForegroundWindow|AppActivate)(?![A-Za-z0-9_])/

/**
 * Every file that names a real-input API, and why it may. Anything else is a new path to real input and fails here:
 * route it through the input lock (src/main/agent-cursor/input-lock.ts) or use screen_act.
 */
const ALLOWED: Record<string, string> = {
  'apps/desktop/src/main/agent-cursor/input-lock.ts': 'the lock: the one path',
  'apps/desktop/src/main/runtime/prompt.ts': 'names them only to forbid them in every agent prompt',
  'apps/desktop/src/main/agent-desktop/agent-surface.ts': 'a comment: the agent desktop never uses it',
  'tools/agent-desktop/src/Program.cs': 'a comment: the agent desktop uses posted messages, never it',
  'apps/desktop/src/main/agent-cursor/real-input-guard.ts': 'the list of refused names',
  'tools/agent-screen/src/Act.cs': 'the native half of the lock (inject) and the focus guard that gives HIS window back',
  'tools/agent-screen/src/Program.cs': 'focus: hands the keyboard back to the window he was in when the quick chat closes (his own action)',
  'apps/desktop/src/main/dictation/paste.ts': 'his own dictation pasting into his own window (his action, not the agent)',
  'tools/agent-screen/proof/send-input.ps1': 'proof kit, opt-in with AGENT_PROOF_REAL_INPUT=1 when nobody uses the PC',
  'tools/agent-screen/proof/lab/giveback.cs': 'lab tool that gives HIS window the keyboard back',
  'tools/agent-screen/proof/lab/quiet.cs': 'lab tool that starts a test program in the background and gives the keyboard back',
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'out' || name === 'dist' || name === 'release') continue
    const path = join(dir, name)
    const info = statSync(path)
    if (info.isDirectory()) walk(path, out)
    else if (/\.(ts|tsx|mjs|cjs|js|cs|ps1|py|sh|json|cmd)$/.test(name) && info.size < 2_000_000) out.push(path)
  }
}

describe('real input has one door', () => {
  it('no file outside the allow list names a real-input API', () => {
    const files: string[] = []
    for (const folder of ['apps', 'packages', 'tools', 'scripts']) walk(join(ROOT, folder), files)
    const offenders = files
      .map((file) => relative(ROOT, file).split(sep).join('/'))
      .filter((file) => !file.startsWith('apps/desktop/test/') && !(file in ALLOWED))
      .filter((file) => WORDS.test(readFileSync(join(ROOT, file), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('every allowed file still exists and still needs its place on the list', () => {
    for (const file of Object.keys(ALLOWED)) expect(WORDS.test(readFileSync(join(ROOT, file), 'utf8')), file).toBe(true)
  })

  it('the guard list covers the names the grep looks for', () => {
    for (const name of ['SetCursorPos', 'mouse_event', 'keybd_event', 'SendInput', 'SendKeys', 'SetForegroundWindow']) expect(REAL_INPUT_NAMES).toContain(name)
  })

  it('every agent is told never to move his pointer or send keys, and to use screen_act', () => {
    const text = NO_REAL_INPUT.join(' ')
    expect(text).toContain('screen_act')
    expect(text).toMatch(/Never move the user's pointer/)
  })
})
