/**
 * Learned apps follow the browser sign-in (23 Oct 2026): any agent that browses in a partition where a
 * learned app's site is signed in may run it, not only helpers whose profile lists it. And a tool input
 * can name a file on this computer, which reaches the page as a File without going through the model.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Tool, ToolContext } from '@agent/core'

import { BASE_PARTITION, GENERAL_ID, ProfileStore, partitionFor } from '../src/main/apps/profiles'
import { LearnedStore } from '../src/main/apps/store'
import { unavailableBrowser, type BrowserDriver } from '../src/main/browser/types'
import { runTools } from '../src/main/runtime/mcp-server'
import { gateTool } from '../src/main/tools/profile-gate'
import { browserRunner, webAppTools } from '../src/main/tools/webapps'
import { testContext, toolNamed } from './support'

let dir = ''
let seq = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-learned-signin-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup(signedIn: (partition: string, url: string) => boolean = () => false) {
  const learned = new LearnedStore(join(dir, 'learned.json'))
  // Saved by the main agent before partitions were recorded, as every app on a live install was.
  learned.save({ id: 'shop', name: 'Shop', startUrl: 'https://shop.example', about: '', tools: [], trusted: false, updatedAt: 0 })
  const profiles = new ProfileStore(join(dir, 'profiles.json'), () => `p${++seq}`)
  const work = profiles.create('Work')
  const client = profiles.create('Client')
  if (!work.ok || !client.ok) throw new Error('not made')
  const used: string[] = []
  const deps = {
    profileOf: (ctx: ToolContext) => (ctx.profile === undefined ? null : profiles.find(ctx.profile)),
    partitionOf: (id: string | null) => profiles.partitionOf(id),
    usePartition: (p: string) => void used.push(p),
    learned,
    addLearned: (profileId: string, appId: string) => void profiles.setLearned(profileId, appId, true),
    profiles: () => profiles.all(),
    siteSignedIn: async (partition: string, url: string) => signedIn(partition, url),
  }
  const run = gateTool({ spec: { name: 'webapp_run', description: '', schema: { type: 'object' } }, run: async () => 'ran' }, deps)
  return { learned, profiles, work: work.value, client: client.value, run, used, deps }
}

describe('who may run a learned app', () => {
  it('a General helper may run an app signed in in the browser it shares with the main agent', async () => {
    const { run, used } = setup()
    expect(await run.run({ app: 'Shop', tool: 'x' }, testContext({ profile: GENERAL_ID }))).toBe('ran')
    expect(used).toEqual([BASE_PARTITION])
  })

  it('the main agent may run it', async () => {
    const { run } = setup()
    expect(await run.run({ app: 'Shop', tool: 'x' }, testContext())).toBe('ran')
  })

  it('a routine (its jobs run as General helpers) may run it', async () => {
    const { run } = setup()
    expect(await run.run({ app: 'Shop', tool: 'x' }, testContext({ profile: GENERAL_ID, agentLabel: 'Routine: Morning brief' }))).toBe('ran')
  })

  it('a profile helper may run an app in its profile list', async () => {
    const { run, profiles, work } = setup()
    profiles.setLearned(work.id, 'shop', true)
    expect(await run.run({ app: 'Shop', tool: 'x' }, testContext({ profile: work.id }))).toBe('ran')
  })

  it("a profile helper may run an app whose site is signed in in its own profile's browser", async () => {
    const { run, work } = setup((partition, url) => partition === partitionFor(work.id) && url === 'https://shop.example')
    expect(await run.run({ app: 'Shop', tool: 'x' }, testContext({ profile: work.id }))).toBe('ran')
  })

  it('a successful run records the browser it worked in, so that browser keeps it without the list', async () => {
    const { run, profiles, work, learned } = setup()
    profiles.setLearned(work.id, 'shop', true)
    await run.run({ app: 'Shop', tool: 'x' }, testContext({ profile: work.id }))
    profiles.setLearned(work.id, 'shop', false)
    expect(learned.find('shop')?.partitions).toEqual([BASE_PARTITION, partitionFor(work.id)])
    expect(await run.run({ app: 'Shop', tool: 'x' }, testContext({ profile: work.id }))).toBe('ran')
    expect(await run.run({ app: 'Shop', tool: 'x' }, testContext({ profile: GENERAL_ID }))).toBe('ran')
  })

  it('a profile helper with neither is refused, told exactly why and how to fix it', async () => {
    const { run, client } = setup()
    expect(await run.run({ app: 'Shop', tool: 'x' }, testContext({ profile: client.id }))).toBe(
      "Shop is a learned app of the General browser; this helper works in profile 'Client', and profile Client's browser is not signed in to shop.example. " +
        "Add Shop to profile Client (Connections > Learned apps > Shop, tick Client; or Edit profile Client > Learned apps), or sign in to shop.example in that profile's browser. " +
        'Tell the main agent this if you cannot do it yourself.',
    )
  })

  it('webapp_list tells a General helper it may run what is signed in there', async () => {
    const { deps } = setup()
    const list = gateTool({ spec: { name: 'webapp_list', description: '', schema: { type: 'object' } }, run: async () => 'Shop (https://shop.example)' }, deps)
    expect(await list.run({}, testContext({ profile: GENERAL_ID }))).toContain('may run: Shop')
  })

  it('the tool server path (plan runs, run_script) behaves the same as the agent loop', async () => {
    const { run } = setup()
    const tools = runTools({ tools: [run], context: testContext({ profile: GENERAL_ID }) })
    const script = toolNamed(tools, 'run_script')
    const out = await script.run({ code: "return await tools.webapp_run({ app: 'Shop', tool: 'x' })" }, testContext({ profile: GENERAL_ID }))
    expect(out).toContain('ran')
    expect(out).not.toContain('not signed in')
  })
})

/** A page in a Node vm that keeps its globals between calls, like a real tab. */
function fakePage() {
  const page: Record<string, unknown> = { Blob, File, atob, received: [] as unknown[] }
  page['window'] = page
  const context = createContext(page)
  const scripts: number[] = []
  const browser: BrowserDriver = {
    ...unavailableBrowser,
    async open() {
      return 'opened'
    },
    currentUrl: () => 'https://shop.example/',
    hasPage: () => true,
    async evaluateRaw(code) {
      scripts.push(code.length)
      return runInContext(code, context)
    },
  }
  return { browser, page, scripts }
}

describe('a file on this computer as a learned-tool input', () => {
  it('reaches the page as a File with its bytes, in chunks, and nothing of it goes back to the model', async () => {
    const { browser, page, scripts } = fakePage()
    const store = new LearnedStore(join(dir, 'learned.json'))
    const tools: Tool[] = webAppTools(store, browserRunner(browser))
    const saved = await toolNamed(tools, 'webapp_save').run(
      {
        name: 'Shop',
        start_url: 'https://shop.example',
        tools: [
          {
            name: 'send_clip',
            description: 'Send a clip',
            params: { clip: { type: 'file', description: 'The clip' }, caption: { type: 'string' } },
            required: ['clip'],
            js: 'const f = args.clip; const bytes = new Uint8Array(await f.arrayBuffer()); received.push({ name: f.name, type: f.type, size: f.size, bytes, caption: args.caption, isFile: f instanceof File }); return { sent: f.name, size: f.size }',
            read_only: false,
          },
          {
            name: 'send_any',
            description: 'Send anything',
            params: { thing: { type: 'string' } },
            required: [],
            js: 'received.push({ name: args.thing.name, size: args.thing.size }); return "ok"',
            read_only: false,
          },
        ] as never,
      },
      testContext({ approve: async () => true }),
    )
    expect(saved).toContain('Saved Shop with 2 tools')

    const bytes = randomBytes(5 * 1024 * 1024 + 123)
    const marker = Buffer.from('UNIQUE-FILE-CONTENT-MARKER')
    marker.copy(bytes, 1000)
    const path = join(dir, 'clip.mp4')
    writeFileSync(path, bytes)
    const asked: string[] = []
    const out = await toolNamed(tools, 'webapp_run').run(
      { app: 'Shop', tool: 'send_clip', args: { clip: path, caption: 'hello' } },
      testContext({ approve: async (_s, details) => (asked.push(details ?? ''), true) }),
    )
    expect(out).toBe('{"sent":"clip.mp4","size":5243003}')
    const got = (page['received'] as Array<{ name: string; type: string; size: number; bytes: Uint8Array; caption: string; isFile: boolean }>)[0]
    expect(got).toMatchObject({ name: 'clip.mp4', type: 'video/mp4', size: bytes.length, caption: 'hello', isFile: true })
    expect(Buffer.compare(Buffer.from(got?.bytes ?? new Uint8Array()), bytes)).toBe(0)
    // Sent in chunks: no one script carries the whole file.
    expect(scripts.length).toBeGreaterThanOrEqual(4)
    expect(Math.max(...scripts)).toBeLessThan(3.5 * 1024 * 1024)
    // The model sees the result only: never the bytes, as text or base64.
    expect(out).not.toContain('UNIQUE-FILE-CONTENT-MARKER')
    expect(out).not.toContain(bytes.subarray(0, 3000).toString('base64').slice(0, 40))
    // Sending a file is ordinary work: no card (main/ask-rule.ts).
    expect(asked).toEqual([])
    // The page lets go of it after the run.
    expect(Object.keys((page['__agentFiles'] as Record<string, unknown>) ?? {})).toEqual([])

    // Any input can carry a file as {"$file": path}.
    const any = await toolNamed(tools, 'webapp_run').run({ app: 'Shop', tool: 'send_any', args: { thing: { $file: path, name: 'renamed.bin' } } }, testContext({ approve: async () => true }))
    expect(any).toBe('ok')
    expect((page['received'] as Array<{ name: string; size: number }>)[1]).toEqual({ name: 'renamed.bin', size: bytes.length })

    // A missing file is a plain error, and the page is never touched.
    const before = scripts.length
    expect(await toolNamed(tools, 'webapp_run').run({ app: 'Shop', tool: 'send_clip', args: { clip: join(dir, 'nope.mp4') } }, testContext({ approve: async () => true }))).toContain('No such file')
    expect(scripts.length).toBe(before)
  })
})
