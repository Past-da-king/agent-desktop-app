import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sanitiseEnv, shellTools } from '../src/main/tools/shell'
import { settingsView, testContext, toolNamed } from './support'

let folder = ''

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'agent-shell-'))
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
  delete process.env['AGENT_TEST_SECRET']
})

function run(approve: () => Promise<boolean>, shell: 'ask' | 'never' = 'ask') {
  return toolNamed(shellTools({ settings: settingsView({ shell }), platform: 'linux' }), 'shell_run')
}

describe('shell_run', () => {
  it('shows the exact command and refuses when the person declines', async () => {
    const approve = vi.fn(async () => false)
    const target = join(folder, 'should-not-exist.txt')
    const result = await run(approve).run(
      { command: `touch ${target}` },
      testContext({ approve }),
    )

    expect(result).toContain('did not approve')
    expect(approve).toHaveBeenCalledOnce()
    expect(approve.mock.calls[0]?.[0]).toBe(`Run: touch ${target}`)
    expect(existsSync(target)).toBe(false)
  })

  it("never runs anything when the setting is 'never'", async () => {
    const approve = vi.fn(async () => true)
    const result = await run(approve, 'never').run(
      { command: 'echo hello' },
      testContext({ approve }),
    )

    expect(result).toContain('turned off')
    expect(approve).not.toHaveBeenCalled()
  })

  it('runs an approved command and returns its output', async () => {
    const result = await run(async () => true).run(
      { command: 'echo hello from the shell' },
      testContext({ approve: async () => true }),
    )

    expect(result).toContain('Exit 0')
    expect(result).toContain('hello from the shell')
  })

  it('runs in the folder it was given', async () => {
    const result = await run(async () => true).run(
      { command: 'pwd', cwd: folder },
      testContext({ approve: async () => true }),
    )
    expect(result).toContain(folder)
  })

  it('strips anything that looks like a secret from the environment', async () => {
    process.env['AGENT_TEST_SECRET'] = 'do-not-leak'
    process.env['AGENT_TEST_TOKEN'] = 'do-not-leak'
    process.env['AGENT_TEST_PASSWORD'] = 'do-not-leak'

    const result = await run(async () => true).run(
      {
        command:
          'node -e "console.log(JSON.stringify([process.env.AGENT_TEST_SECRET, process.env.AGENT_TEST_TOKEN, process.env.AGENT_TEST_PASSWORD]))"',
      },
      testContext({ approve: async () => true }),
    )

    expect(result).not.toContain('do-not-leak')
    expect(result).toContain('[null,null,null]')
  })

  it('stops a command that runs past its timeout', async () => {
    const result = await run(async () => true).run(
      { command: 'node -e "setTimeout(() => {}, 10000)"', timeoutSec: 1 },
      testContext({ approve: async () => true }),
    )

    expect(result).toContain('Timed out after 1 second')
  })

  it('stops a command when the run is stopped', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const result = await run(async () => true).run(
      { command: 'node -e "setTimeout(() => {}, 10000)"', timeoutSec: 30 },
      testContext({ approve: async () => true, signal: controller.signal }),
    )

    expect(result).toContain('Stopped by the user')
  })

  it('caps a flood of output', async () => {
    const result = await run(async () => true).run(
      { command: 'node -e "process.stdout.write(\'x\'.repeat(30000))"' },
      testContext({ approve: async () => true }),
    )

    expect(result.length).toBeLessThanOrEqual(20_100)
    expect(result.length).toBeGreaterThan(19_000)
    expect(result).toContain('cut')
  })

  it('reports a folder that is not there instead of starting', async () => {
    const approve = vi.fn(async () => true)
    const result = await run(approve).run(
      { command: 'echo hi', cwd: join(folder, 'missing') },
      testContext({ approve }),
    )

    expect(result).toContain('is not a folder')
    expect(approve).not.toHaveBeenCalled()
  })
})

describe('sanitiseEnv', () => {
  it('keeps ordinary values and drops secret-looking names', () => {
    const clean = sanitiseEnv({
      PATH: '/usr/bin',
      HOME: '/home/someone',
      OPENAI_API_KEY: 'sk-x',
      GITHUB_TOKEN: 't',
      DB_PASSWORD: 'p',
      SOME_SECRET_VALUE: 's',
    })
    expect(clean).toEqual({ PATH: '/usr/bin', HOME: '/home/someone' })
  })
})
