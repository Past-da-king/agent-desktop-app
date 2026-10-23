/**
 * Wiring: a plan run (Claude or Codex) works in the project's folder, with the access the person chose, and helpers on the
 * Codex path are the app's own, not Codex sub-agents that die with the turn (bug of 23 Oct 2026: a Codex project chat
 * ran read-only in its private folder, and every helper it started was killed the moment its turn ended).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS, type Settings } from '@agent/core'

import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import type { CliTurn } from '../src/main/runtime/cli-agent'
import type { CliHost, CliTurnRequest } from '../src/main/runtime/cli-host'
import { HelperManager } from '../src/main/runtime/helpers'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset, buildWorkerToolset } from '../src/main/runtime/toolset'
import { secretsView, settingsView } from './support'

const seen: CliTurn[] = []
vi.mock('../src/main/runtime/cli-agent', async (original) => {
  const real = await original<typeof import('../src/main/runtime/cli-agent')>()
  return {
    ...real,
    runCliTurn: async (turn: CliTurn) => {
      seen.push(turn)
      return { sessionId: null, text: 'ok' }
    },
  }
})

const { CliHost: RealCliHost } = await import('../src/main/runtime/cli-host')

const temp: string[] = []
const closers: Array<() => unknown> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
  seen.length = 0
})

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-work-'))
  temp.push(dir)
  return dir
}


function host(settings: Partial<Settings>): CliHost {
  const cli = new RealCliHost(folder(), () => ({ ...DEFAULT_SETTINGS, ...settings }), process.cwd())
  closers.push(() => cli.close())
  return cli
}

function request(extra: Partial<CliTurnRequest>): CliTurnRequest {
  const signal = new AbortController().signal
  return {
    cli: 'codex',
    thread: 'p1',
    tools: [],
    system: 's',
    prompt: 'p',
    context: { agentLabel: 'main', activity: async () => 0, updateActivity: async () => undefined, ask: async () => null, approve: async () => true, notify: async () => undefined, signal },
    signal,
    onEvent: async () => undefined,
    onCall: async () => undefined,
    onResult: async () => undefined,
    ...extra,
  }
}

describe('the plan host hands the engine its folder and access', () => {
  it('Run without asking frees the engine in the project folder; asking does not', async () => {
    const project = folder()
    await host({ shell: 'always' }).turn(request({ folder: project }))
    expect(seen.at(-1)?.folder).toBe(project)
    expect(seen.at(-1)?.access).toBe('free')
    await host({ shell: 'ask' }).turn(request({ folder: project, cli: 'claude' }))
    expect(seen.at(-1)?.folder).toBe(project)
    expect(seen.at(-1)?.access).toBe('asked')
  })

  it('a helper placed here by another computer keeps that computer’s choice', async () => {
    const r = request({ folder: folder() })
    await host({ shell: 'always' }).turn({ ...r, context: { ...r.context, shell: 'ask' } })
    expect(seen.at(-1)?.access).toBe('asked')
  })

  it('a folder that is not on this computer is left out, and the chat’s own folder is used', async () => {
    await host({ shell: 'always' }).turn(request({ folder: join(folder(), 'gone') }))
    expect(seen.at(-1)?.folder).toBeUndefined()
  })
})

describe('project chats and their helpers pass the project folder on a plan', () => {
  it('the project chat’s own turn and a helper it starts both get the folder', async () => {
    const db = new Store(':memory:')
    closers.push(() => db.close())
    const project = folder()
    await db.upsert('project', { name: 'CMS', description: '', icon: { glyph: 'folder', color: 'iris' }, path: project, profile: '', hidden: false, chats: ['pcms1'] })
    const requests: CliTurnRequest[] = []
    const cli = {
      turn: async (req: CliTurnRequest) => {
        requests.push(req)
        return { text: 'done' }
      },
      forget: () => undefined,
    } as unknown as CliHost
    const settings = settingsView({ ...DEFAULT_SETTINGS, mode: 'subscription', cli: 'codex', notifications: false })
    const manager = new HelperManager({
      store: db,
      settings,
      secrets: secretsView(''),
      providerFactory: () => null,
      workerTools: buildWorkerToolset({ store: db }),
      cli,
      deliver: async () => undefined,
    })
    closers.push(() => manager.stopAll())
    const runner = new Runner({
      store: db,
      settings,
      secrets: secretsView(''),
      tools: buildToolset({ store: db, helpers: manager }),
      providerFactory: () => null,
      emit: () => undefined,
      timeZone: 'UTC',
      helpers: manager,
      cli,
    })
    closers.push(() => runner.dispose())

    await runner.send('Build the CMS', [], 'pcms1')
    expect(requests.find((r) => r.thread === 'chat:pcms1')?.folder).toBe(project)

    await manager.delegate([{ label: 'Docs', brief: 'Write the architecture doc.' }], false, { chat: 'pcms1' })
    await waitFor(() => requests.some((r) => r.thread.startsWith('helper:')))
    expect(requests.find((r) => r.thread.startsWith('helper:'))?.folder).toBe(project)

    // The main thread has no project folder.
    await runner.send('Hello')
    expect(requests.find((r) => r.thread === 'main')?.folder).toBeUndefined()
  })
})
