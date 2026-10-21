import { describe, expect, it } from 'vitest'

import {
  alongsideBrief,
  classifierPrompt,
  decideRoute,
  heuristicRelation,
  joinNote,
  parseVerdict,
  type Classifier,
} from '../src/main/runtime/chat-route'

const question = (text: string) => ({ goal: 'Reconcile the Acme invoices', text, recent: ['User: Reconcile the Acme invoices'] })

describe('the quick word check', () => {
  it.each([
    ['ok thanks', 'ack'],
    ['Thank you!', 'ack'],
    ['?!', 'ack'],
    ['wait, I meant the September ones', 'supersede'],
    ['Actually use the other folder', 'supersede'],
    ['scrap that and do the summary first', 'supersede'],
    ['Never mind the totals', 'supersede'],
    ['also flag anything over R 10,000', 'related'],
    ['Oh and send it to Thandi when done', 'related'],
    ['btw the file is on the desktop', 'related'],
    ["how's it going?", 'related'],
    ["What's the weather in Durban on Friday?", 'unclear'],
    ['Book a table for two at Marble on Saturday', 'unclear'],
  ])('%s -> %s', (text, expected) => {
    expect(heuristicRelation(text)).toBe(expected)
  })
})

describe('the classifier reply', () => {
  it('reads one clear word and calls anything else unsure', () => {
    expect(parseVerdict('SAME')).toBe('same')
    expect(parseVerdict('different.')).toBe('different')
    expect(parseVerdict('  Different  ')).toBe('different')
    expect(parseVerdict('UNSURE')).toBe('unsure')
    expect(parseVerdict('It could be the SAME or DIFFERENT')).toBe('unsure')
    expect(parseVerdict('')).toBe('unsure')
  })

  it('asks with the running task, recent lines and the new message', () => {
    const prompt = classifierPrompt({ ...question('Order printer paper'), hasFiles: true })
    expect(prompt).toContain('Reconcile the Acme invoices')
    expect(prompt).toContain('Order printer paper')
    expect(prompt).toContain('with files attached')
  })
})

describe('deciding the route', () => {
  const answer = (verdict: 'same' | 'different' | 'unsure'): Classifier => async () => verdict

  it('joins on clear words without calling the classifier', async () => {
    let calls = 0
    const counting: Classifier = async () => {
      calls += 1
      return 'different'
    }
    expect(await decideRoute(question('also add the totals'), counting)).toMatchObject({ route: 'join', why: 'words' })
    expect(await decideRoute(question('wait, not that one'), counting)).toMatchObject({ route: 'join', why: 'words' })
    expect(calls).toBe(0)
  })

  it('goes alongside only when the classifier says different', async () => {
    expect(await decideRoute(question('Order printer paper'), answer('different'))).toMatchObject({ route: 'alongside', why: 'classifier' })
    expect(await decideRoute(question('Use the October statement'), answer('same'))).toMatchObject({ route: 'join', why: 'classifier' })
    expect(await decideRoute(question('Order printer paper'), answer('unsure'))).toMatchObject({ route: 'join', why: 'unsure' })
  })

  it('joins when there is no classifier, when it fails, and when it is too slow', async () => {
    expect(await decideRoute(question('Order printer paper'), null)).toMatchObject({ route: 'join', why: 'no-classifier' })
    const broken: Classifier = async () => {
      throw new Error('provider down')
    }
    expect(await decideRoute(question('Order printer paper'), broken)).toMatchObject({ route: 'join', why: 'error' })
    let aborted = false
    const slow: Classifier = (_q, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true
        })
        setTimeout(() => resolve('different'), 2000)
      })
    const started = Date.now()
    expect(await decideRoute(question('Order printer paper'), slow, 60)).toMatchObject({ route: 'join', why: 'timeout' })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(aborted).toBe(true)
  })

  it('frames a joined note and a separate brief so the agent knows what to do', () => {
    expect(joinNote('use October')).toMatch(/drop the old plan/)
    expect(joinNote('use October')).toContain('use October')
    const brief = alongsideBrief('Order printer paper', 'Reconcile the Acme invoices')
    expect(brief).toContain('Reconcile the Acme invoices')
    expect(brief).toContain('shown to the user as a short summary')
    expect(brief.endsWith('Order printer paper')).toBe(true)
  })
})
