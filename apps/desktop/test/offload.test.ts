/**
 * Offload (docs/devices-protocol.md s12): helpers placed on another brain, as two nodes in one process. Each node has
 * its own store, AI and helper manager; a small pump replicates their rows both ways like the devices link does.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, LEGACY_ACCOUNT, providerFor, schema, type Settings, type Tool, type TriggerRow } from '@agent/core'

import { startFakeAi, type FakeAi, type FakeReply } from '../../../packages/core/test/fake-ai'
import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { HelperManager, type OffloadLink } from '../src/main/runtime/helpers'
import { choosePlacement, Offload, ROUTINE_GRACE_MS, type PlaceCandidate } from '../src/main/runtime/offload'
import { Scheduler } from '../src/main/runtime/scheduler'
import { buildWorkerToolset } from '../src/main/runtime/toolset'
import { TurnLeases, rankedBrains } from '../src/main/runtime/turns'
import { SettingsStore } from '../src/main/settings'
import { secretsView, settingsView } from './support'

const READY: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false }

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

/** Settings as a stored file would load them. */
function loadSettings(raw: Record<string, unknown>): Settings {
  const dir = mkdtempSync(join(tmpdir(), 'offload-settings-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'settings.json')
  writeFileSync(file, JSON.stringify(raw))
  return new SettingsStore(file).get()
}

// ---- placement policy -------------------------------------------------------------------------------------------

function candidate(patch: Partial<PlaceCandidate> & { accounts?: string[]; cap?: number; active?: number } = {}): PlaceCandidate {
  return {
    id: patch.id ?? 'dev_srv',
    name: patch.name ?? 'Box',
    kind: patch.kind ?? 'server',
    up: patch.up ?? true,
    capacity: { name: 'Box', kind: patch.kind ?? 'server', accounts: patch.accounts ?? ['acct'], cap: patch.cap ?? 4, active: patch.active ?? 0, browser: false },
  }
}

describe('placement', () => {
  const job = { text: 'Research standing desks and compare three', account: 'acct' }

  it('best sends a job that does not need this computer to a server that can run its AI', () => {
    expect(choosePlacement(job, [candidate()], 'desktop', 'best')).toMatchObject({ device: 'dev_srv' })
  })

  it('keeps jobs that need this computer, its files, screen or signed-in browser', () => {
    for (const text of ['Read C:\\Users\\me\\report.docx and sum it up', 'Take a screenshot of my screen', 'Post it with my signed-in browser', 'Open the file in my Downloads folder']) {
      expect(choosePlacement({ ...job, text }, [candidate()], 'desktop', 'best').device).toBeNull()
    }
    expect(choosePlacement({ ...job, localFolder: true }, [candidate()], 'desktop', 'best').device).toBeNull()
  })

  it('keeps a job whose brief names this computer, by its device name or its host name', () => {
    const names = ['Desk', 'WORKSTATION-01']
    for (const text of ['Fix the app on WORKSTATION-01 and build it', 'Run it on desk, not the server']) {
      expect(choosePlacement({ ...job, text, selfNames: names }, [candidate()], 'desktop', 'best')).toMatchObject({ device: null, why: 'it needs this computer' })
    }
    // Part of a word is not the name.
    expect(choosePlacement({ ...job, text: 'Research desktops and compare three', selfNames: names }, [candidate()], 'desktop', 'best').device).toBe('dev_srv')
  })

  it('never a brain that cannot run its AI, is offline, full or takes no work', () => {
    expect(choosePlacement(job, [candidate({ accounts: ['other'] })], 'desktop', 'best').device).toBeNull()
    expect(choosePlacement(job, [candidate({ up: false })], 'desktop', 'best').device).toBeNull()
    expect(choosePlacement(job, [candidate({ active: 4 })], 'desktop', 'best').device).toBeNull()
    expect(choosePlacement(job, [candidate({ cap: 0 })], 'desktop', 'best').device).toBeNull()
    // Named explicitly, the same rules hold, with the reason.
    expect(choosePlacement({ ...job, device: 'Box' }, [candidate({ accounts: ['other'] })], 'desktop', 'best')).toMatchObject({ device: null, why: 'Box cannot run that AI' })
  })

  it('the setting and the job pick: here, a named device, the least busy server', () => {
    expect(choosePlacement(job, [candidate()], 'desktop', 'here').device).toBeNull()
    expect(choosePlacement({ ...job, device: 'here' }, [candidate()], 'desktop', 'best').device).toBeNull()
    expect(choosePlacement({ ...job, device: 'box' }, [candidate()], 'desktop', 'here').device).toBe('dev_srv')
    expect(choosePlacement(job, [candidate()], 'desktop', 'dev_srv').device).toBe('dev_srv')
    const two = [candidate({ id: 'a', name: 'A', active: 3 }), candidate({ id: 'b', name: 'B', active: 1 })]
    expect(choosePlacement(job, two, 'desktop', 'best').device).toBe('b')
    // A computer is only used by best when the job needs one; a server keeps its own work.
    expect(choosePlacement(job, [candidate({ kind: 'desktop' })], 'desktop', 'best').device).toBeNull()
    expect(choosePlacement(job, [candidate({ kind: 'desktop' })], 'server', 'best').device).toBeNull()
    expect(choosePlacement({ ...job, text: 'Open the file on this computer' }, [candidate({ kind: 'desktop' })], 'server', 'best').device).toBe('dev_srv')
  })
})

// ---- two nodes --------------------------------------------------------------------------------------------------

interface Mesh {
  down: Set<string>
  up(id: string): boolean
}

/** Copies each store's own rows to the other every 30 ms, while both ends are up. */
function pump(a: Store, b: Store, mesh: Mesh, aId: string, bId: string): () => void {
  let stopped = false
  const tick = async (): Promise<void> => {
    if (stopped || !mesh.up(aId) || !mesh.up(bId)) return
    await b.applyRemote(await a.localChanges(null), aId)
    await a.applyRemote(await b.localChanges(null), bId)
  }
  const timer = setInterval(() => void tick().catch(() => undefined), 30)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

interface Node {
  id: string
  db: Store
  fake: FakeAi
  helpers: HelperManager
  offload: Offload
  leases: TurnLeases
  delivered: string[]
  cannot: string[]
}

async function makeNode(id: string, kind: 'desktop' | 'server', mesh: Mesh, options: { script: (body: Record<string, unknown>, index: number) => FakeReply; tools?: Tool[]; key?: string | null; mode?: string; now?: () => number; settings?: Partial<Settings> }): Promise<Node> {
  const db = new Store(':memory:')
  const fake = await startFakeAi(options.script)
  const delivered: string[] = []
  const cannot: string[] = []
  let helpers: HelperManager | null = null
  const leases = new TurnLeases({
    store: db,
    selfId: () => id,
    resumeTurn: () => undefined,
    resumeJob: async (helper, note) => {
      await helpers?.push(helper, note)
    },
    lost: (lease) => void helpers?.stop(lease.messageId),
    health: async (row) => ({ up: mesh.up(row.id), ready: mesh.up(row.id) }),
    brains: () => rankedBrains(db),
    heartbeatMs: 100,
    staleMs: 300,
    watchMs: 60_000,
  })
  const manager = new HelperManager({
    store: db,
    settings: settingsView({ ...READY, ...(options.settings ?? {}) }),
    secrets: secretsView(options.key === undefined ? 'test-key' : options.key),
    ...(options.now === undefined ? {} : { now: options.now }),
    providerFactory: (_s, key) => providerFor({ provider: 'openai', key, baseUrl: fake.url, allowHttp: true }),
    workerTools: [...buildWorkerToolset({ store: db }), ...(options.tools ?? [])],
    deliver: (note) => {
      delivered.push(note)
    },
    platform: 'linux',
    timeZone: 'UTC',
    leases,
  })
  helpers = manager
  const offload = new Offload({
    store: db,
    selfId: () => id,
    isSelf: (other) => other === id,
    reachable: (other) => mesh.up(other) && mesh.up(id),
    capacity: () => ({ name: id, kind, accounts: [LEGACY_ACCOUNT], cap: 4, active: manager.activeCount(), browser: false }),
    mode: () => options.mode ?? 'best',
    handle: (msg) => manager.onRemote(msg),
    beatMs: 100,
    scanMs: 50,
  })
  const link: OffloadLink = {
    selfId: () => id,
    isSelf: (other) => other === id,
    up: (other) => offload.up(other),
    place: (req) => offload.place(req),
    send: (to, op, helper, extra) => offload.send(to, op, helper, extra),
    leaseHolder: (helper) => offload.leaseHolder(helper),
    deviceName: (other) => offload.deviceName(other),
    cannotRun: (account) => {
      cannot.push(account)
    },
  }
  manager.setOffload(link)
  offload.start()
  cleanups.push(async () => {
    offload.stop()
    leases.stop()
    await manager.stopAll()
    await fake.close()
    db.close()
  })
  return { id, db, fake, helpers: manager, offload, leases, delivered, cannot }
}

async function twoNodes(options: { pc: Parameters<typeof makeNode>[3]; server: Parameters<typeof makeNode>[3] }): Promise<{ pc: Node; srv: Node; mesh: Mesh; cut: () => void }> {
  const mesh: Mesh = { down: new Set(), up: (id) => !mesh.down.has(id) }
  const pc = await makeNode('dev_pc', 'desktop', mesh, options.pc)
  const srv = await makeNode('dev_srv', 'server', mesh, options.server)
  for (const db of [pc.db, srv.db]) {
    await db.upsert('device', { id: 'dev_pc', name: 'Desk', kind: 'desktop', platform: 'windows', roles: ['brain', 'hands'], priority: 0 })
    await db.upsert('device', { id: 'dev_srv', name: 'Box', kind: 'server', platform: 'linux', roles: ['brain', 'hands'], priority: 1 })
  }
  const cut = pump(pc.db, srv.db, mesh, 'dev_pc', 'dev_srv')
  cleanups.push(cut)
  // The PC knows the server's capacity before anything is placed.
  await waitFor(async () => (await pc.offload.candidates()).some((each) => each.id === 'dev_srv' && each.up), 5000)
  return { pc, srv, mesh, cut }
}

function idOf(started: string): string {
  const match = /#([0-9a-f-]{36})/.exec(started)
  if (match?.[1] === undefined) throw new Error(`no helper id in: ${started}`)
  return match[1]
}

/** A step that waits until it is released or the run is stopped. */
function gate(): { tool: Tool; started: () => number; release: () => void } {
  let count = 0
  const waiting: Array<() => void> = []
  return {
    started: () => count,
    release: () => {
      for (const go of waiting.splice(0)) go()
    },
    tool: {
      spec: { name: 'slow_step', description: 'A long step.', schema: schema([], {}) },
      run: (_input, ctx) =>
        new Promise<string>((resolve) => {
          count++
          waiting.push(() => resolve('step done'))
          ctx.signal.addEventListener('abort', () => resolve('cut off'), { once: true })
        }),
    },
  }
}

const text = (body: Record<string, unknown>): string => JSON.stringify(body['messages'] ?? [])

describe('helpers of a project that works in a folder on this computer', () => {
  it('stay on this computer, like the project chat itself', async () => {
    const { pc, srv } = await twoNodes({
      pc: { script: () => ({ text: 'Changed the code here.' }) },
      server: { script: () => ({ text: 'Server should not think' }) },
    })
    await pc.db.upsert('project', { name: 'App', description: '', path: '/home/someone/app', profile: '', hidden: false, chats: ['proj-chat'] } as never)
    const started = await pc.helpers.delegate([{ label: 'Fix it', brief: 'Research the market for standing desks and compare three' }], false, { chat: 'proj-chat' })
    const id = idOf(started)
    expect(pc.helpers.live().find((each) => each.id === id)?.remote).not.toBe(true)
    await waitFor(() => pc.fake.requests.length >= 1, 8000)
    expect(srv.fake.requests.length).toBe(0)
  })
})

describe('helpers on another brain', () => {
  it('a helper delegated here runs on the server; its card works here and its result lands here', async () => {
    const { pc, srv } = await twoNodes({
      pc: { script: () => ({ text: 'PC should not think' }) },
      server: { script: () => ({ text: 'Found three vendors.' }) },
    })
    const started = await pc.helpers.delegate([{ label: 'Market scan', brief: 'Research the market for standing desks and compare three' }])
    const id = idOf(started)
    expect(pc.helpers.live()).toMatchObject([{ id, label: 'Market scan', remote: true }])

    await waitFor(() => pc.delivered.length === 1, 8000)
    expect(pc.delivered[0]).toContain(`[Helper #${id} "Market scan" finished]`)
    expect(pc.delivered[0]).toContain('Found three vendors.')
    expect(srv.fake.requests.length).toBe(1)
    expect(pc.fake.requests.length).toBe(0)
    expect(srv.delivered).toEqual([])
    // The card, as this computer sees it: the server's own writes, replicated.
    await waitFor(async () => JSON.parse((await pc.db.get('chat_item', id))?.meta ?? '{}').state === 'done', 3000)
    const meta = JSON.parse((await pc.db.get('chat_item', id))?.meta ?? '{}') as Record<string, unknown>
    expect(meta).toMatchObject({ runOn: 'dev_srv', placedBy: 'dev_pc', runsOnName: 'Box', result: 'Found three vendors.' })
    expect(pc.helpers.live()).toEqual([])
    // It ran under the server's job lease.
    expect(await pc.db.get('turn_lease', `job-${id}`)).toMatchObject({ brainId: 'dev_srv', status: 'done' })
    // The server's helper prompt says where it runs, and how to reach the PC.
    expect(JSON.stringify(srv.fake.requests[0]?.body ?? {})).toContain('device_tool on \\"Desk\\"')
  })

  it('steer and stop from this computer reach the brain running it', async () => {
    const step = gate()
    const { pc, srv } = await twoNodes({
      pc: { script: () => ({ text: 'PC should not think' }) },
      server: {
        tools: [step.tool],
        script: (body, index) => (text(body).includes('Second job') ? (index >= 0 && !text(body).includes('step done') && !text(body).includes('cut off') ? { toolCalls: [{ name: 'slow_step', input: {} }] } : { text: 'never' }) : index === 0 ? { toolCalls: [{ name: 'slow_step', input: {} }] } : { text: text(body).includes('7pm show') ? 'Booked the 7pm show.' : 'Booked something.' }),
      },
    })
    const id = idOf(await pc.helpers.delegate([{ label: 'Tickets', brief: 'Find cinema tickets for tonight' }]))
    await waitFor(() => step.started() === 1, 8000)
    // The card reaches this computer by replication, a moment after the step started over there.
    await waitFor(async () => (await pc.helpers.status()).includes('[working'), 3000)
    expect(await pc.helpers.steer(id, 'The person means the 7pm show')).toContain('gets your message')
    // The note reaches the server's run before its next step.
    await waitFor(async () => (await srv.db.list('job')).some((row) => row.kind === 'msg' && row.op === 'steer' && row.status === 'done'), 5000)
    step.release()
    await waitFor(() => pc.delivered.length === 1, 8000)
    expect(pc.delivered[0]).toContain('Booked the 7pm show.')

    // Stop: the server's run is aborted, and this computer's agent hears it stopped (0.2.76), once.
    const second = idOf(await pc.helpers.delegate([{ label: 'Second', brief: 'Second job: watch prices all night' }]))
    await waitFor(() => step.started() === 2, 8000)
    expect(await pc.helpers.stop(second)).toBe(true)
    await waitFor(async () => JSON.parse((await pc.db.get('chat_item', second))?.meta ?? '{}').state === 'stopped', 8000)
    await waitFor(() => pc.helpers.live().length === 0, 3000)
    await waitFor(() => pc.delivered.length === 2, 8000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(pc.delivered).toHaveLength(2)
    expect(pc.delivered[1]).toContain('"Second" stopped: it was stopped')
  })

  it('a question from the helper on the server is answered on this computer', async () => {
    const { pc } = await twoNodes({
      pc: { script: () => ({ text: 'PC should not think' }) },
      server: { script: (body, index) => (index === 0 ? { toolCalls: [{ name: 'ask_user', input: { question: 'Which city?', options: ['Durban', 'Cape Town'] } }] } : { text: text(body).includes('Durban') ? 'Durban it is.' : 'No answer.' }) },
    })
    idOf(await pc.helpers.delegate([{ label: 'Trip', brief: 'Plan a weekend trip' }]))
    let card = ''
    await waitFor(async () => {
      card = (await pc.db.list('chat_item')).find((row) => row.kind === 'question')?.id ?? ''
      return card !== ''
    }, 8000)
    expect(await pc.helpers.answer(card, 'Durban')).toBe(true)
    await waitFor(() => pc.delivered.length === 1, 8000)
    expect(pc.delivered[0]).toContain('Durban it is.')
  })

  it('when the server dies mid-job, this computer takes the lease over and finishes it; one runner at a time', async () => {
    const step = gate()
    const { pc, srv, mesh, cut } = await twoNodes({
      pc: { script: (body) => ({ text: text(body).includes('was interrupted') ? 'Finished here after the takeover.' : 'fresh' }) },
      server: { tools: [step.tool], script: () => ({ toolCalls: [{ name: 'slow_step', input: {} }] }) },
    })
    const id = idOf(await pc.helpers.delegate([{ label: 'Long job', brief: 'Crawl every page of the catalogue' }]))
    await waitFor(() => step.started() === 1, 8000)
    await waitFor(async () => (await pc.db.get('turn_lease', `job-${id}`))?.brainId === 'dev_srv', 3000)
    // The server goes away: no more replication, no health.
    cut()
    mesh.down.add('dev_srv')
    srv.leases.stop()
    srv.offload.stop()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await pc.leases.claimStale()).toBe(1)
    await waitFor(() => pc.delivered.length === 1, 8000)
    expect(pc.delivered[0]).toContain('Finished here after the takeover.')
    expect(await pc.db.get('turn_lease', `job-${id}`)).toMatchObject({ brainId: 'dev_pc', attempt: 2, status: 'done' })
    expect(pc.helpers.live()).toEqual([])
  })

  it('a server that cannot run the AI sends the helper back, and it runs here', async () => {
    const { pc, srv } = await twoNodes({
      pc: { script: () => ({ text: 'Done on the PC.' }) },
      // The server says it can run the account but holds no key for it.
      server: { key: null, script: () => ({ text: 'server should not think' }) },
    })
    idOf(await pc.helpers.delegate([{ label: 'Lookup', brief: 'Look up the opening hours of the library' }]))
    await waitFor(() => pc.delivered.length === 1, 8000)
    expect(pc.delivered[0]).toContain('Done on the PC.')
    expect(srv.fake.requests).toHaveLength(0)
    expect(srv.cannot).toEqual([LEGACY_ACCOUNT])
  })

  it('a start the server never took is run here', async () => {
    const { pc, mesh, cut } = await twoNodes({
      pc: { script: () => ({ text: 'Ran here in the end.' }) },
      server: { script: () => ({ text: 'never' }) },
    })
    cut()
    const id = idOf(await pc.helpers.delegate([{ label: 'Lookup', brief: 'Look up the weather' }]))
    expect(pc.helpers.live()).toMatchObject([{ id, remote: true }])
    mesh.down.add('dev_srv')
    expect(await pc.helpers.takeBack(0)).toBe(1)
    await waitFor(() => pc.delivered.length === 1, 8000)
    expect(pc.delivered[0]).toContain('Ran here in the end.')
  })

  // 23 Oct 2026: the tunnel to the server dropped and came back every few seconds. The PC took back two helpers the
  // server was running (their lease had not reached it yet, and the link was down at that instant), ran them a
  // second time, and they held two of its four slots while their cards said they ran on the server.
  it('a link that drops and comes back does not take back a helper the server is running', async () => {
    const step = gate()
    let skew = 0
    const now = (): number => Date.now() + skew
    const { pc, mesh, cut } = await twoNodes({
      pc: { now, script: () => ({ text: 'PC ran it' }) },
      server: { tools: [step.tool], script: () => ({ toolCalls: [{ name: 'slow_step', input: {} }] }) },
    })
    const id = idOf(await pc.helpers.delegate([{ label: 'Long job', brief: 'Crawl every page of the catalogue' }]))
    await waitFor(() => step.started() === 1, 8000)
    // Replication stalls before the server's lease reaches the PC.
    cut()
    await pc.db.remove('turn_lease', `job-${id}`)
    // A minute passes while the link is up (the tunnel flaps, but it is up when the PC looks).
    skew += 60_000
    expect(await pc.helpers.takeBack(45_000)).toBe(0)
    // Then it drops for a moment: not a brain that went away.
    mesh.down.add('dev_srv')
    expect(await pc.helpers.takeBack(45_000)).toBe(0)
    expect(pc.fake.requests).toHaveLength(0)
    expect(pc.helpers.slots().running).toBe(0)
    // Gone for the whole window: now it is taken back and run here.
    skew += 60_000
    expect(await pc.helpers.takeBack(45_000)).toBe(1)
    await waitFor(() => pc.delivered.length === 1, 8000)
    expect(pc.delivered[0]).toContain('PC ran it')
  })

  it('a helper placed on the server works with the commands-and-files choice of the computer that placed it', async () => {
    const seen: Array<string | undefined> = []
    const probe: Tool = {
      spec: { name: 'probe_shell', description: 'Says the shell policy.', schema: schema([], {}) },
      run: async (_input, ctx) => {
        seen.push(ctx.shell)
        return `PROBED-${ctx.shell ?? 'own'}`
      },
    }
    const { pc, srv } = await twoNodes({
      pc: { settings: { shell: 'always' }, script: () => ({ text: 'PC should not think' }) },
      server: { settings: { shell: 'ask' }, tools: [probe], script: (body) => (text(body).includes('PROBED-') ? { text: 'Checked.' } : { toolCalls: [{ name: 'probe_shell', input: {} }] }) },
    })
    const id = idOf(await pc.helpers.delegate([{ label: 'Probe', brief: 'Research which rules apply' }]))
    await waitFor(() => pc.delivered.length === 1, 8000)
    expect(seen).toEqual(['always'])
    expect(JSON.parse((await pc.db.get('chat_item', id))?.meta ?? '{}')).toMatchObject({ placerShell: 'always', runOn: 'dev_srv' })
    // The server's own helpers keep the server's own choice.
    await srv.helpers.delegate([{ label: 'Own', brief: 'Research on the server itself', device: 'here' }])
    await waitFor(() => srv.delivered.length === 1, 8000)
    expect(seen).toEqual(['always', undefined])
  })

  it('with Devices off (no self id) or no other brain, every helper runs here as before', async () => {
    const mesh: Mesh = { down: new Set(), up: () => true }
    const alone = await makeNode('dev_pc', 'desktop', mesh, { script: () => ({ text: 'Alone and fine.' }) })
    await alone.helpers.delegate([{ label: 'Solo', brief: 'Research something long' }])
    await waitFor(() => alone.delivered.length === 1, 8000)
    expect(alone.fake.requests).toHaveLength(1)
    expect((await alone.db.list('job')).filter((row) => row.kind === 'msg')).toEqual([])
  })
})

describe('restarts and project chats', () => {
  it('a restart does not fail a helper another brain is running', async () => {
    const mesh: Mesh = { down: new Set(), up: () => true }
    const node = await makeNode('dev_srv', 'server', mesh, { script: () => ({ text: '' }) })
    const theirs = await node.db.upsert('chat_item', { kind: 'helper', text: 'Their job', meta: JSON.stringify({ label: 'Theirs', state: 'working' }) })
    await node.db.upsert('turn_lease', { id: `job-${theirs.id}`, kind: 'job', chatId: 'main', messageId: theirs.id, brainId: 'dev_pc', status: 'running', attempt: 1, heartbeatAt: Date.now(), startedAt: Date.now(), prompt: '' })
    const ours = await node.db.upsert('chat_item', { kind: 'helper', text: 'Our job', meta: JSON.stringify({ label: 'Ours', state: 'working' }) })
    await node.helpers.restore()
    expect(JSON.parse((await node.db.get('chat_item', theirs.id))?.meta ?? '{}').state).toBe('working')
    expect(JSON.parse((await node.db.get('chat_item', ours.id))?.meta ?? '{}').state).toBe('failed')
  })

  it('a placed project chat gets its messages on the brain running it; its message_main comes back', async () => {
    const { pc, srv } = await twoNodes({ pc: { script: () => ({ text: '' }) }, server: { script: () => ({ text: '' }) } })
    await pc.offload.placeChat('chat-x', 'dev_srv')
    expect(await pc.offload.routeChat('chat-x')).toBe('dev_srv')
    expect(await pc.offload.routeChat('main')).toBeNull()
    await waitFor(async () => (await srv.db.get('job', 'chat-chat-x')) !== null, 3000)
    // On the server it runs here; what it writes to the main chat goes back to the PC.
    expect(await srv.offload.routeChat('chat-x')).toBeNull()
    expect(await srv.offload.routeChat('main', 'chat-x')).toBe('dev_pc')
    expect(await srv.offload.routeChat('main', 'chat-other')).toBeNull()
  })
})

describe('routines on one brain only', () => {
  it('the preferred brain claims a due slot; another waits, and claims it only when nobody did', async () => {
    const { pc, srv } = await twoNodes({ pc: { script: () => ({ text: '' }) }, server: { script: () => ({ text: '' }) } })
    await waitFor(async () => (await srv.offload.candidates()).some((each) => each.id === 'dev_pc' && each.up), 5000)
    const req = { text: 'Morning brief', account: LEGACY_ACCOUNT }
    // The PC prefers the server for it: it leaves the slot.
    expect(await pc.offload.claimRoutine('r1', '0', req, 0)).toBe(false)
    // The server prefers itself: it claims.
    expect(await srv.offload.claimRoutine('r1', '0', req, 50)).toBe(true)
    await waitFor(async () => (await pc.db.get('job', 'routine-r1@0')) !== null, 3000)
    expect(await pc.offload.claimRoutine('r1', '0', req, 0)).toBe(false)

    // Another slot the server never claims: after the grace, the PC runs it.
    let now = Date.now()
    const late = new Offload({
      store: pc.db,
      selfId: () => 'dev_pc',
      isSelf: (id) => id === 'dev_pc',
      reachable: () => true,
      capacity: () => ({ name: 'Desk', kind: 'desktop', accounts: [LEGACY_ACCOUNT], cap: 4, active: 0, browser: false }),
      mode: () => 'best',
      handle: async () => true,
      now: () => now,
    })
    expect(await late.claimRoutine('r1', '1', req, 0)).toBe(false)
    now += ROUTINE_GRACE_MS + 1
    expect(await late.claimRoutine('r1', '1', req, 0)).toBe(true)
  })

  it('a project chat placed here carries the commands-and-files choice of the computer that placed it', async () => {
    const db = new Store(':memory:')
    cleanups.push(() => db.close())
    const make = (self: string): Offload =>
      new Offload({ store: db, selfId: () => self, isSelf: (id) => id === self, reachable: () => true, capacity: () => ({ name: self, kind: 'server', accounts: [], cap: 1, active: 0, browser: false }), mode: () => 'best', handle: async () => true })
    await make('dev_pc').placeChat('pc1', 'dev_srv', JSON.stringify({ shell: 'always' }))
    expect(await make('dev_srv').placedChatShell('pc1')).toBe('always')
    // The computer that placed it uses its own setting; a chat nobody placed has none.
    expect(await make('dev_pc').placedChatShell('pc1')).toBeUndefined()
    expect(await make('dev_srv').placedChatShell('pc2')).toBeUndefined()
  })

  it('the scheduler skips a due routine another brain runs', async () => {
    const db = new Store(':memory:')
    cleanups.push(() => db.close())
    const trigger = await db.upsert('trigger', { name: 'Brief', kind: 'interval', spec: '15', prompt: 'Do it', enabled: true, lastRunAt: 0, lastResult: '' })
    const ran: string[] = []
    const scheduler = new Scheduler({
      store: db,
      runner: { runRoutine: async (t: TriggerRow) => (ran.push(t.id), { text: 'ok', waiting: false }) },
      claim: async () => false,
      now: () => Date.now(),
    })
    await scheduler.tick()
    expect(ran).toEqual([])
    const mine = new Scheduler({ store: db, runner: { runRoutine: async (t: TriggerRow) => (ran.push(t.id), { text: 'ok', waiting: false }) }, claim: async () => true })
    await mine.tick()
    expect(ran).toEqual([trigger.id])

    // Another brain ran a slot: its result arrives by replication and is announced here once.
    const other = await db.upsert('trigger', { name: 'Digest', kind: 'interval', spec: '15', prompt: 'Do it', enabled: true, lastRunAt: 0, lastResult: '' })
    const heard: string[] = []
    const watching = new Scheduler({ store: db, runner: { runRoutine: async () => ({ text: 'x', waiting: false }) }, claim: async () => false, notifyRoutine: (_id, name, result) => heard.push(`${name}: ${result}`) })
    await watching.tick()
    await db.upsert('trigger', { id: other.id, lastRunAt: Date.now(), lastResult: 'Sent the digest.' })
    await watching.tick()
    await watching.tick()
    expect(heard).toEqual(['Digest: Sent the digest.'])
  })
})

describe('settings', () => {
  it('helpersRunOn and devicesJobLimit are kept per computer and cleaned; no limit by default', () => {
    expect(DEFAULT_SETTINGS.helpersRunOn).toBe('best')
    expect(DEFAULT_SETTINGS.devicesJobLimit).toBe(0)
    expect(loadSettings({ helpersRunOn: 'here', devicesJobLimit: 2 })).toMatchObject({ helpersRunOn: 'here', devicesJobLimit: 2 })
    expect(loadSettings({ helpersRunOn: 'dev_N4f-abc', devicesJobLimit: 99 })).toMatchObject({ helpersRunOn: 'dev_N4f-abc', devicesJobLimit: 99 })
    expect(loadSettings({ helpersRunOn: '../x y', devicesJobLimit: 'lots' })).toMatchObject({ helpersRunOn: 'best', devicesJobLimit: 0 })
    // The old setting: its stored 4 was the old default and goes; "none" was a real choice and stays.
    expect(loadSettings({ devicesJobCap: 4 })).toMatchObject({ devicesJobLimit: 0 })
    expect(loadSettings({ devicesJobCap: 0 })).toMatchObject({ devicesJobLimit: -1 })
    expect(loadSettings({ devicesJobLimit: -5 })).toMatchObject({ devicesJobLimit: -1 })
    // Helpers, steps and routines at once: 0 or blank = no limit, the default.
    expect(DEFAULT_SETTINGS).toMatchObject({ helpersAtOnce: 0, helperMaxSteps: 0, routinesAtOnce: 0 })
    expect(loadSettings({ helpersAtOnce: 12, helperMaxSteps: '', routinesAtOnce: -3 })).toMatchObject({ helpersAtOnce: 12, helperMaxSteps: 0, routinesAtOnce: 0 })
  })
})
