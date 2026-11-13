import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TriggerRow, WorkerEvent } from '@agent/core'

import { Store } from '../src/main/db'
import { changesSince } from '../src/main/decisions/wire'
import { routineDeltaCheck, triageDeskBatch } from '../src/main/decisions/precheck'
import { DecisionService, type DecisionSettings } from '../src/main/decisions/service'
import { DecisionError, type Answer, type DecisionProvider } from '../src/main/decisions/types'
import type { RoutineRunResult } from '../src/main/runtime/runner'
import { Scheduler, type RoutineRunner } from '../src/main/runtime/scheduler'
import { EventRouter, type DeskHost } from '../src/main/workers/router'
import { WorkerStore } from '../src/main/workers/store'

function noul(p: number): Answer {
  return { type: 'noul', value: p >= 0.5, probability: p, confidence: Math.max(p, 1 - p) }
}

/** A decision model that says P(yes) by a rule on the text it was given. */
function modelBy(rule: (text: string) => number | 'error'): { provider: DecisionProvider; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    provider: {
      id: 'gemini',
      async decide(input, questions) {
        const text = typeof input === 'string' ? input : ''
        calls.push(text)
        const p = rule(text)
        if (p === 'error') throw new DecisionError('timeout', 'slow')
        return { answers: Object.fromEntries(Object.keys(questions).map((id) => [id, noul(p)])), refused: [] }
      },
    },
  }
}

function service(provider: DecisionProvider, over: Partial<DecisionSettings> = {}): DecisionService {
  return new DecisionService({ settings: () => ({ enabled: true, backend: 'gemini', threshold: 0.9, ...over }), keys: { gemini: () => 'k', openai: () => null, jev: () => null }, providers: { gemini: provider } })
}

function event(id: string, text: string): WorkerEvent {
  return { id, worker: 'w_a', source: 'mail', event: 'message', payload: JSON.stringify({ text }), dedupeKey: id, seenAt: 1, receivedAt: 2, status: 'new', routine: '', note: '' }
}

const TRIGGER = { name: 'Mail desk', prompt: 'Triage mail. Hand real requests to the owner.' }

describe('desk triage pre-check', () => {
  it('skips only what the model is confident is noise; everything else goes to the desk', async () => {
    const { provider } = modelBy((t) => (t.includes('newsletter') ? 0.02 : t.includes('maybe') ? 0.3 : 0.97))
    const batch = [event('1', 'weekly newsletter'), event('2', 'Please refund me'), event('3', 'maybe something'), event('4', 'another newsletter')]
    const result = await triageDeskBatch(service(provider), TRIGGER, batch)
    expect(result.skipped.map((s) => s.event.id)).toEqual(['1', '4'])
    expect(result.kept.map((e) => e.id)).toEqual(['2', '3'])
    expect(result.skipped[0]?.reason).toContain('not for the desk')
  })

  it('off: the provider is never asked and every event is kept', async () => {
    const { provider, calls } = modelBy(() => 0.01)
    const batch = [event('1', 'newsletter')]
    const result = await triageDeskBatch(service(provider, { enabled: false }), TRIGGER, batch)
    expect(result.kept).toEqual(batch)
    expect(calls).toHaveLength(0)
  })

  it('an error or a timeout keeps the event: the desk sees it as before', async () => {
    const { provider } = modelBy(() => 'error')
    const batch = [event('1', 'newsletter')]
    const result = await triageDeskBatch(service(provider), TRIGGER, batch)
    expect(result.kept).toEqual(batch)
    expect(result.skipped).toEqual([])
  })

  it('a confident yes is kept, and the desk brief and event reach the model as fenced data', async () => {
    const { provider, calls } = modelBy(() => 0.99)
    const batch = [event('1', 'Can you call me back?')]
    const result = await triageDeskBatch(service(provider), TRIGGER, batch)
    expect(result.kept).toEqual(batch)
    expect(calls[0]).toContain('Triage mail.')
    expect(calls[0]).toContain('<<<data')
    expect(calls[0]).toContain('Can you call me back?')
  })

  it('never uses the LLM fallback: a low confidence simply keeps the event', async () => {
    const { provider } = modelBy(() => 0.4)
    const complete = vi.fn(async () => '{}')
    const svc = new DecisionService({ settings: () => ({ enabled: true, backend: 'gemini', threshold: 0.9 }), keys: { gemini: () => 'k', openai: () => null, jev: () => null }, providers: { gemini: provider }, complete: () => complete })
    const result = await triageDeskBatch(svc, TRIGGER, [event('1', 'hmm')])
    expect(result.kept).toHaveLength(1)
    expect(complete).not.toHaveBeenCalled()
  })
})

describe('routine delta check', () => {
  const routine = { name: 'Inbox sweep', prompt: 'Look at new mail and report what matters.', lastResult: 'Nothing urgent.' }

  it('skips when the model is confident nothing relevant changed', async () => {
    const { provider } = modelBy(() => 0.02)
    const verdict = await routineDeltaCheck(service(provider), routine, '')
    expect(verdict.skip).toBe(true)
    expect(verdict.reason).toContain('Nothing new')
  })
  it('runs when unsure, when it errors, when off, and when the app cannot tell what changed', async () => {
    expect((await routineDeltaCheck(service(modelBy(() => 0.5).provider), routine, 'x')).skip).toBe(false)
    expect((await routineDeltaCheck(service(modelBy(() => 'error').provider), routine, 'x')).skip).toBe(false)
    const off = modelBy(() => 0.01)
    expect((await routineDeltaCheck(service(off.provider, { enabled: false }), routine, '')).skip).toBe(false)
    expect(off.calls).toHaveLength(0)
    const unknown = modelBy(() => 0.01)
    expect((await routineDeltaCheck(service(unknown.provider), routine, null)).skip).toBe(false)
    expect(unknown.calls).toHaveLength(0)
  })
  it('changesSince lists worker events newer than the last run, or null when it cannot tell', () => {
    const store = { events: () => [{ ...event('new', 'fresh'), receivedAt: 200 }, { ...event('old', 'stale'), receivedAt: 50 }] }
    expect(changesSince(store, 100)).toContain('fresh')
    expect(changesSince(store, 100)).not.toContain('stale')
    expect(changesSince(store, 300)).toBe('')
    expect(changesSince(store, null)).toBeNull()
    expect(changesSince(null, 100)).toBeNull()
  })
})

describe('EventRouter with the pre-check', () => {
  let root: string
  let workers: WorkerStore
  let store: Store
  let runs: number
  const messages: string[] = []
  const desk: DeskHost = {
    async runDesk(spec, message) {
      runs += 1
      messages.push(message)
      return { deskId: spec.deskId || 'h1', state: 'done', result: 'Handled.' }
    },
  }
  beforeEach(() => {
    vi.useFakeTimers()
    root = mkdtempSync(join(tmpdir(), 'dec-router-'))
    workers = new WorkerStore(root)
    store = new Store(':memory:')
    runs = 0
    messages.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
    workers.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  async function routine(): Promise<TriggerRow> {
    return store.upsert('trigger', { name: 'Mail desk', kind: 'event', spec: '{"worker":"w_aaaa01"}', prompt: 'Triage mail.', enabled: true, lastRunAt: null, lastResult: '', gatherSeconds: 5, profile: '', deskId: '' })
  }
  const emit = (key: string, text: string): WorkerEvent => workers.addEvent('w_aaaa01', { source: 'mail', event: 'message', payload: { text }, dedupeKey: key })!

  it('events the model is sure are noise never reach the desk and are marked ignored with the reason', async () => {
    await routine()
    const { provider } = modelBy((t) => (t.includes('newsletter') ? 0.01 : 0.99))
    const svc = service(provider)
    const router = new EventRouter({ store, workers, desk, triage: (trigger, batch) => triageDeskBatch(svc, trigger, batch) })
    await router.start()
    await router.offer(emit('1', 'weekly newsletter'))
    await router.offer(emit('2', 'refund please'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(runs).toBe(1)
    expect(messages[0]).toContain('refund please')
    expect(messages[0]).not.toContain('weekly newsletter')
    const ignored = workers.events({ status: 'ignored' })
    expect(ignored).toHaveLength(1)
    expect(ignored[0]?.note).toContain('Decision pre-check')
    expect(workers.events({ status: 'routed' })).toHaveLength(1)
  })

  it('when every event is noise the desk does not run at all', async () => {
    await routine()
    const svc = service(modelBy(() => 0.01).provider)
    const router = new EventRouter({ store, workers, desk, triage: (trigger, batch) => triageDeskBatch(svc, trigger, batch) })
    await router.start()
    await router.offer(emit('1', 'newsletter a'))
    await router.offer(emit('2', 'newsletter b'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(runs).toBe(0)
    expect(workers.events({ status: 'ignored' })).toHaveLength(2)
  })

  it('a pre-check that throws leaves the desk run exactly as before', async () => {
    await routine()
    const router = new EventRouter({ store, workers, desk, triage: async () => { throw new Error('boom') } })
    await router.start()
    await router.offer(emit('1', 'anything'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(runs).toBe(1)
    expect(workers.events({ status: 'routed' })).toHaveLength(1)
  })

  it('with Decisions off nothing changes: no provider call, every event routed', async () => {
    await routine()
    const m = modelBy(() => 0.01)
    const svc = service(m.provider, { enabled: false })
    const router = new EventRouter({ store, workers, desk, triage: (trigger, batch) => triageDeskBatch(svc, trigger, batch) })
    await router.start()
    await router.offer(emit('1', 'newsletter'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(runs).toBe(1)
    expect(m.calls).toHaveLength(0)
  })
})

describe('Scheduler with the routine pre-check', () => {
  let store: Store
  beforeEach(() => {
    store = new Store(':memory:')
  })
  afterEach(() => store.close())

  class FakeRunner implements RoutineRunner {
    calls = 0
    async runRoutine(): Promise<RoutineRunResult> {
      this.calls += 1
      return { text: 'Did the work.', waiting: false }
    }
  }
  async function make(patch: Partial<TriggerRow>): Promise<TriggerRow> {
    return store.upsert('trigger', { name: 'Sweep', kind: 'interval', spec: '30', prompt: 'Check for new things.', enabled: true, lastRunAt: 1000, lastResult: '', ...patch })
  }

  it('a routine that opted in is skipped quietly when nothing is new', async () => {
    const runner = new FakeRunner()
    const notices: string[] = []
    const scheduler = new Scheduler({ store, runner, notifyRoutine: (_i, n, r) => notices.push(n + r), precheck: async () => ({ skip: true, reason: 'Nothing new.' }) })
    const row = await make({ deltaCheck: true })
    await scheduler.runNow(row.id)
    expect(runner.calls).toBe(0)
    expect(notices).toEqual([])
    expect((await store.get('trigger', row.id))?.lastResult).toBe('Skipped: Nothing new.')
  })
  it('runs as always when the pre-check says run, throws, or the routine did not opt in', async () => {
    const runner = new FakeRunner()
    const ask = vi.fn(async () => ({ skip: true, reason: 'x' }))
    const scheduler = new Scheduler({ store, runner, precheck: ask })
    await scheduler.runNow((await make({})).id)
    expect(runner.calls).toBe(1)
    expect(ask).not.toHaveBeenCalled()
    const throwing = new Scheduler({ store, runner, precheck: async () => { throw new Error('boom') } })
    await throwing.runNow((await make({ deltaCheck: true })).id)
    expect(runner.calls).toBe(2)
    const runs = new Scheduler({ store, runner, precheck: async () => ({ skip: false, reason: 'low_confidence' }) })
    await runs.runNow((await make({ deltaCheck: true })).id)
    expect(runner.calls).toBe(3)
    const bare = new Scheduler({ store, runner })
    await bare.runNow((await make({ deltaCheck: true })).id)
    expect(runner.calls).toBe(4)
  })
})
