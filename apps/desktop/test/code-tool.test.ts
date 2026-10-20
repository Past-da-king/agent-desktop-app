import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { codeTools, findOnPath } from '../src/main/tools/code'
import { testContext, toolNamed } from './support'

let folder = ''
const python = findOnPath('python3')

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'agent-code-test-'))
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

function runCode(approve: () => Promise<boolean>, extra: { timeoutMs?: number; findCommand?: () => string | null } = {}) {
  return toolNamed(
    codeTools({ tempRoot: folder, timeoutMs: 5_000, ...extra }),
    'run_code',
  )
}

describe('run_code', () => {
  it('runs JavaScript and returns what it printed', async () => {
    const result = await runCode(async () => true).run(
      { language: 'javascript', code: 'console.log(6 * 7)' },
      testContext({ approve: async () => true }),
    )

    expect(result).toContain('Exit 0')
    expect(result).toContain('42')
  })

  it('asks before running and does nothing when declined', async () => {
    const approve = vi.fn(async () => false)
    const result = await runCode(approve).run(
      { language: 'javascript', code: "console.log('ran')" },
      testContext({ approve }),
    )

    expect(result).toContain('did not approve')
    expect(result).not.toContain('ran')
    expect(approve).toHaveBeenCalledOnce()
  })

  it('reports the files it created, as real paths', async () => {
    const result = await runCode(async () => true).run(
      {
        language: 'javascript',
        code: "const fs = await import('node:fs'); fs.writeFileSync('report.csv', 'a,b\\n1,2'); console.log('written')",
      },
      testContext({ approve: async () => true }),
    )

    expect(result).toContain('Files written:')
    expect(result).toContain('report.csv')
    const listed = result.split('\n').find((line) => line.includes('report.csv'))
    const path = listed?.replace(/^- /, '').replace(/ \(\d+ bytes\)$/, '') ?? ''
    expect(existsSync(path)).toBe(true)
  })

  it('stops code that runs too long', async () => {
    const result = await runCode(async () => true, { timeoutMs: 1_200 }).run(
      { language: 'javascript', code: 'setTimeout(() => {}, 5000)' },
      testContext({ approve: async () => true }),
    )
    expect(result).toContain('Timed out')
  })

  it('says plainly when the language has no runtime', async () => {
    const result = await runCode(async () => true, { findCommand: () => null }).run(
      { language: 'python', code: 'print(1)' },
      testContext({ approve: async () => true }),
    )
    expect(result).toContain('Python is not installed')
  })

  it('rejects a language it does not know', async () => {
    const result = await runCode(async () => true).run(
      { language: 'ruby', code: 'puts 1' },
      testContext({ approve: async () => true }),
    )
    expect(result).toContain("Choose 'javascript' or 'python'")
  })

  it.skipIf(python === null)('runs Python when it is installed', async () => {
    const result = await runCode(async () => true).run(
      { language: 'python', code: 'print(20 + 22)' },
      testContext({ approve: async () => true }),
    )
    expect(result).toContain('42')
  })
})
