import { afterEach, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { DEFAULT_SETTINGS } from '@agent/core'
import { Store } from '../src/main/db'
import { PrGate, ATTESTATION_FIELDS } from '../src/main/runtime/pr-gate'
import { ghExecutionEnv } from '../src/main/runtime/pr-gate-exec'
import { testContext } from './support'

/** Shared scaffolding for the PR gate execution tests: a disposable HOME, a fake gh that records its calls, a gate and a real child shell. */
export function prGateHelpers(tag: string) {
  const cleanup: Array<() => void> = []
  afterEach(() =>
    cleanup
      .splice(0)
      .reverse()
      .forEach((fn) => fn()),
  )
  function fixture() {
    const cwd = mkdtempSync(join(tmpdir(), 'pr-' + tag + '-')),
      marker = join(cwd, 'calls')
    cleanup.push(() => rmSync(cwd, { recursive: true, force: true }))
    mkdirSync(join(cwd, 'repo'))
    writeFileSync(
      join(cwd, 'gh'),
      '#!/bin/sh\npwd >> "' +
        marker +
        '"\nprintf "%s\n" "$@" >> "' +
        marker +
        '"\n',
      { mode: 0o700 },
    )
    const store = new Store(':memory:')
    cleanup.push(() => store.close())
    const gate = new PrGate(store, () => ({
      ...DEFAULT_SETTINGS,
      prGateEnabled: true,
    }))
    const ctx = testContext({ shell: 'always' })
    const env = {
      HOME: cwd,
      USERPROFILE: cwd,
      GH_CONFIG_DIR: cwd,
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      PATH: cwd + ':/usr/bin:/bin',
    }
    return { cwd, marker, store, gate, ctx, env }
  }
  async function attest(f: ReturnType<typeof fixture>, held: string) {
    const id = held.match(/Gate id: ([a-f0-9-]+)/)?.[1]
    expect(id, held).toBeTruthy()
    const evidence = Object.fromEntries(
      ATTESTATION_FIELDS.map((field) => [
        field,
        field === 'reviewerAgentId'
          ? 'independent-' + tag + '-reviewer'
          : field === 'testProof'
            ? '/tmp/isolated/' + tag + '.txt'
            : 'Isolated ' + tag + ' evidence for ' + field,
      ]),
    )
    expect(await f.gate.attest(id!, evidence, f.ctx)).toContain(
      'Attestation recorded',
    )
  }
  function child(
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('/bin/bash', ['--noprofile', '--norc', '-c', command], {
        cwd,
        env: ghExecutionEnv(env),
        stdio: 'pipe',
      })
      let output = ''
      proc.stdout.on('data', (value) => (output += value))
      proc.stderr.on('data', (value) => (output += value))
      proc.once('error', reject)
      proc.once('close', (code) => resolve('exit:' + code + ' ' + output))
      proc.stdin.end()
    })
  }
  return { cleanup, fixture, attest, child }
}
