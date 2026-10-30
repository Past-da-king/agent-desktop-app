/**
 * The 54 s freeze of 30 Oct 2026: a helper sent back read every step of every helper (72,773 rows, 279 MB) on the
 * main thread. The read is now its own newest steps, chat reads are capped, big reads run in workers, old step bodies
 * leave the rows, recall is bounded and cached, and a held helper says so.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { encodeStamp, type Change, type ChatItem, type MemoryRow } from '@agent/core'

import { LIST_WHERE_CAP, Store } from '../src/main/db'
import { rank, recallFor } from '../src/main/runtime/recall'
import { spawnOffThread } from '../src/main/spawn-off-thread'
import { helperHold, helperLine, type HelperView } from '../src/shared/helper-cards'

const dirs: string[] = []
const stores: Store[] = []

function fileStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'listwhere-'))
  dirs.push(dir)
  const store = new Store(join(dir, 'agent.db'))
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows may hold a just-closed file for a moment.
    }
  }
})

function step(id: string, createdAt: number, stdout = '', helper = 'h1'): Partial<ChatItem> & { id: string; kind: 'activity'; createdAt: number } {
  return { id, kind: 'activity', text: `step ${id}`, createdAt, meta: JSON.stringify({ helper, status: 'done', run: { tool: 'shell_run', stdout, stderr: '', input: '{}' } }) }
}

describe('no chat read returns everything by accident', () => {
  it('a read with no limit gets the newest LIST_WHERE_CAP rows, in the order it asked for, and the log says so', async () => {
    const store = fileStore()
    const total = LIST_WHERE_CAP + 25
    await store.batch(async () => {
      for (let i = 0; i < total; i++) await store.upsert('chat_item', step(`s${i}`, 1_000 + i))
    })
    const rows = await store.listWhere('chat_item', { kind: 'activity' })
    expect(rows).toHaveLength(LIST_WHERE_CAP)
    expect(rows[0]?.id).toBe('s25')
    expect(rows[rows.length - 1]?.id).toBe(`s${total - 1}`)
    expect(store.recentReads().some((read) => read.capped === true && read.what.includes('"kind":"activity"') && read.rows === LIST_WHERE_CAP)).toBe(true)
    const all = await store.listWhere('chat_item', { kind: 'activity', all: true })
    expect(all).toHaveLength(total)
    expect(all[0]?.id).toBe('s0')
  }, 60_000)

  it('no source file reads every step of every helper', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.tsx?$/.test(name) && /\{\s*kind:\s*'activity'\s*\}/.test(readFileSync(path, 'utf8'))) offenders.push(name)
      }
    }
    walk(join(__dirname, '..', 'src', 'main'))
    expect(offenders).toEqual([])
  })
})

describe('reads in a worker', () => {
  it('never holds the main thread: heartbeat stays regular through a read of hundreds of MB', async () => {
    const store = fileStore()
    store.startReader()
    const stdout = 'x'.repeat(20_000)
    await store.batch(async () => {
      for (let i = 0; i < 8_000; i++) await store.upsert('chat_item', step(`s${i}`, 1_000 + i, stdout))
    })
    let longest = 0
    let last = performance.now()
    const beat = setInterval(() => {
      const now = performance.now()
      longest = Math.max(longest, now - last)
      last = now
    }, 2)
    const rows = await store.listWhere('chat_item', { kind: 'activity', all: true })
    clearInterval(beat)
    expect(rows).toHaveLength(8_000)
    expect(rows[0]?.id).toBe('s0')
    expect(rows[7_999]?.id).toBe('s7999')
    expect(longest).toBeLessThan(250)
    const reads = store.recentReads()
    expect(reads[reads.length - 1]?.thread).toBe('worker')
  }, 120_000)

  it('sees every write committed before it asked, even while another big read is open', async () => {
    const store = fileStore()
    store.startReader({ size: 2 })
    await store.batch(async () => {
      for (let i = 0; i < 3_000; i++) await store.upsert('chat_item', step(`s${i}`, 1_000 + i, 'y'.repeat(4_000)))
    })
    const big = store.listWhere('chat_item', { kind: 'activity', all: true })
    await store.upsert('chat_item', { id: 'new', kind: 'user', text: 'hello', createdAt: 9_000_000 })
    const seen = await store.listWhere('chat_item', { kind: 'user' })
    expect(seen.map((row) => row.id)).toEqual(['new'])
    expect(await big).toHaveLength(3_000)
    // One after another on one worker: the second begins a new snapshot too.
    store.close()
    stores.length = 0
    const one = fileStore()
    one.startReader({ size: 1 })
    await one.upsert('chat_item', { id: 'a', kind: 'user', text: 'a', createdAt: 1 })
    const first = one.listWhere('chat_item', { kind: 'user' })
    await one.upsert('chat_item', { id: 'b', kind: 'user', text: 'b', createdAt: 2 })
    const second = await one.listWhere('chat_item', { kind: 'user' })
    await first
    expect(second.map((row) => row.id)).toEqual(['a', 'b'])
  }, 60_000)

  it('inside an open transaction it reads on the writing connection, so it sees what is not committed yet', async () => {
    const store = fileStore()
    store.startReader()
    await store.batch(async () => {
      await store.upsert('chat_item', { id: 'inside', kind: 'user', text: 'x', createdAt: 5 })
      const rows = await store.listWhere('chat_item', { kind: 'user' })
      expect(rows.map((row) => row.id)).toEqual(['inside'])
    })
  })

  it('a dead worker costs a slower read, never a lost one', async () => {
    const store = fileStore()
    store.startReader()
    await store.upsert('chat_item', { id: 'kept', kind: 'user', text: 'x', createdAt: 5 })
    ;(store as unknown as { reader: { stop(): void } }).reader.stop()
    expect((await store.listWhere('chat_item', { kind: 'user' })).map((row) => row.id)).toEqual(['kept'])
    expect((await store.list('chat_item')).map((row) => row.id)).toEqual(['kept'])
  })

  it('whole lists through the worker: small entities cached, big ones in store order', async () => {
    const store = fileStore()
    store.startReader()
    await store.upsert('task', { id: 't1', title: 'one', status: 'todo', owner: 'user' })
    expect((await store.list('task')).map((row) => row.id)).toEqual(['t1'])
    await store.upsert('task', { id: 't2', title: 'two', status: 'todo', owner: 'user' })
    expect((await store.list('task')).map((row) => row.id).sort()).toEqual(['t1', 't2'])
    await store.upsert('chat_item', { id: 'b', kind: 'user', text: 'b', createdAt: 20 })
    await store.upsert('chat_item', { id: 'a', kind: 'user', text: 'a', createdAt: 10 })
    expect((await store.list('chat_item')).map((row) => row.id)).toEqual(['a', 'b'])
  })
})

describe('old step bodies leave the rows', () => {
  const BIG = 'o'.repeat(30_000)
  const OLD = 1_000

  it('a list gets the light row, get() the whole step; nothing is sent and a later pull gets it whole', async () => {
    const store = fileStore()
    await store.upsert('chat_item', step('old', OLD, BIG))
    await store.upsert('chat_item', step('small', OLD + 1, 'short'))
    await store.upsert('chat_item', step('new', 10_000_000, BIG))
    const seqBefore = store.logSeq()
    const stampOf = (): string | undefined => (store as unknown as { db: { prepare(s: string): { get(a: string): { stamp: string } } } }).db.prepare("SELECT stamp FROM rows WHERE entity='chat_item' AND cid=?").get('old').stamp
    const stampBefore = stampOf()

    const out = await store.archiveSlice(5_000_000)
    expect(out.changed).toBe(1)
    expect(store.bodiesKept()).toBe(1)
    expect((await store.archiveSlice(5_000_000, out.next)).more).toBe(false)
    expect(store.logSeq()).toBe(seqBefore)
    expect(stampOf()).toBe(stampBefore)

    const listed = (await store.listWhere('chat_item', { kind: 'activity' })).find((row) => row.id === 'old')
    expect(listed?.meta.length).toBeLessThan(1_000)
    const full = await store.get('chat_item', 'old')
    expect((JSON.parse(full?.meta ?? '{}') as { run: { stdout: string } }).run.stdout).toBe(BIG)
    const newer = (await store.listWhere('chat_item', { kind: 'activity' })).find((row) => row.id === 'new')
    expect((JSON.parse(newer?.meta ?? '{}') as { run: { stdout: string } }).run.stdout).toBe(BIG)

    const { changes } = store.changesAfter(0)
    const pulled = changes.find((change) => change.id === 'old')
    expect((JSON.parse(String(pulled?.payload['meta'])) as { run: { stdout: string } }).run.stdout).toBe(BIG)
  })

  it('a change merges onto the whole step, and the kept body goes', async () => {
    const store = fileStore()
    await store.upsert('chat_item', step('old', OLD, BIG))
    await store.archiveSlice(5_000_000)
    await store.upsert('chat_item', { id: 'old', text: 'edited' })
    expect(store.bodiesKept()).toBe(0)
    const row = await store.get('chat_item', 'old')
    expect(row?.text).toBe('edited')
    expect((JSON.parse(row?.meta ?? '{}') as { run: { stdout: string } }).run.stdout).toBe(BIG)
  })

  it('a newer version from another device replaces it, and a removed step leaves nothing behind', async () => {
    const store = fileStore()
    await store.upsert('chat_item', step('old', OLD, BIG))
    await store.upsert('chat_item', step('gone', OLD + 1, BIG))
    await store.archiveSlice(5_000_000)
    expect(store.bodiesKept()).toBe(2)
    const change: Change = { entity: 'chat_item', id: 'old', deleted: false, stamp: encodeStamp({ millis: Date.now() + 60_000, counter: 0, device: 'other-device' }), payload: { kind: 'activity', text: 'theirs', meta: '{}', createdAt: OLD } }
    await store.applyRemote([change], 'peer')
    expect((await store.get('chat_item', 'old'))?.text).toBe('theirs')
    expect(store.bodiesKept()).toBe(1)
    await store.remove('chat_item', 'gone')
    expect(store.bodiesKept()).toBe(0)
  })

  it('leaves a running step, and a step with nothing to cut, whole', async () => {
    const store = fileStore()
    await store.upsert('chat_item', { id: 'running', kind: 'activity', text: 'r', createdAt: OLD, meta: JSON.stringify({ helper: 'h', status: 'running', run: { stdout: BIG } }) })
    await store.upsert('chat_item', { id: 'texty', kind: 'activity', text: 't'.repeat(9_000), createdAt: OLD + 1, meta: '{}' })
    const out = await store.archiveSlice(5_000_000)
    expect(out.changed).toBe(0)
    expect(store.bodiesKept()).toBe(0)
  })

  it('through the workers too: a slice is found off the main thread', async () => {
    const store = fileStore()
    store.startReader()
    await store.upsert('chat_item', step('old', OLD, BIG))
    expect((await store.archiveSlice(5_000_000)).changed).toBe(1)
    expect((await store.list('chat_item'))[0]?.meta.length).toBeLessThan(1_000)
  })
})

describe('recall is cached and bounded', () => {
  const page = (id: string, title: string, body: string, updatedAt = 1_000): MemoryRow => ({ id, title, body, topics: '', kind: 'fact', pinned: false, source: 'user', updatedAt, createdAt: 1 }) as MemoryRow

  it('the same message against the same pages does not walk the pages again; a changed page does', () => {
    let reads = 0
    const counted = (row: MemoryRow): MemoryRow =>
      new Proxy(row, {
        get(target, key, receiver) {
          if (key === 'title') reads += 1
          return Reflect.get(target, key, receiver) as unknown
        },
      })
    const pages = [counted(page('p1', 'Cosmiprint launch', 'launch plan')), counted(page('p2', 'Other', 'nothing'))]
    const first = recallFor('the cosmiprint launch', pages, 5)
    expect(first.map((row) => row.id)).toEqual(['p1'])
    const after = reads
    expect(recallFor('the cosmiprint launch', pages, 5).map((row) => row.id)).toEqual(['p1'])
    expect(reads).toBe(after)
    const changed = [counted(page('p1', 'Cosmiprint launch', 'launch plan', 2_000)), pages[1]!]
    recallFor('the cosmiprint launch', changed, 5)
    expect(reads).toBeGreaterThan(after)
  })

  it('a pasted log looks at a bounded number of words', () => {
    const words = Array.from({ length: 20_000 }, (_, i) => `word${i}`).join(' ')
    const pages = Array.from({ length: 300 }, (_, i) => page(`p${i}`, `Page ${i}`, 'lorem ipsum '.repeat(400)))
    pages.push(page('late', 'word19999', 'x'))
    pages.push(page('early', 'word3', 'x'))
    const out = rank(words, pages, 5)
    expect(out.map((row) => row.id)).toEqual(['early'])
  })
})

describe('a held helper says so', () => {
  const view = (over: Partial<HelperView>): HelperView => ({ id: 'h', label: 'H', brief: '', state: 'working', summary: '', queued: false, startedAt: 0, endedAt: null, result: '', activity: [], model: '', where: '', ...over })
  const oldStep = { id: 's', kind: 'activity', text: 'Ran something earlier', createdAt: 1, meta: '{"helper":"h","status":"done"}' } as ChatItem

  it('paused by the guard: its reason, not an old step and not working', () => {
    const helper = view({ queued: true, summary: 'Paused: low on memory (0.8 GB free)', activity: [oldStep] })
    expect(helperHold(helper)).toEqual({ kind: 'paused', line: 'Paused: low on memory (0.8 GB free)' })
    expect(helperLine(helper)).toBe('Paused: low on memory (0.8 GB free)')
  })

  it('queued, whatever the old wording said', () => {
    for (const summary of ['Queued: waiting for a free slot', 'Waiting its turn', '']) {
      const helper = view({ queued: true, summary, activity: [oldStep] })
      expect(helperHold(helper)?.kind).toBe('queued')
      expect(helperLine(helper)).toBe('Queued: waiting for a free slot')
    }
  })

  it('a running or ended helper is not held', () => {
    expect(helperHold(view({ summary: 'Thinking' }))).toBeNull()
    expect(helperHold(view({ state: 'done', queued: true }))).toBeNull()
  })
})

describe('a long-lived helper process starts off the main thread', () => {
  it('carries its pipes across and says when it ends', async () => {
    const script = "process.stdin.setEncoding('utf8');process.stdin.on('data',(d)=>{process.stdout.write('got '+d);if(d.includes('bye'))process.exit(7)})"
    const child = spawnOffThread(process.execPath, ['-e', script])
    const heard: string[] = []
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => heard.push(chunk))
    const exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -2)))
    child.stdin.write('hello\n')
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (heard.join('').includes('got hello')) {
          clearInterval(check)
          resolve()
        }
      }, 20)
    })
    child.stdin.write('bye\n')
    expect(await exited).toBe(7)
  }, 30_000)

  it('a command that cannot start is an error, then an exit, never a throw', async () => {
    const child = spawnOffThread('C:/no/such/program.exe', [])
    const failed = new Promise<void>((resolve) => child.on('error', () => resolve()))
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
    await failed
    await exited
  }, 30_000)
})
