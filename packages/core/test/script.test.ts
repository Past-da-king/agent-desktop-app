/**
 * Programmatic tool calling (run_script): one script calls many tools and only its small return value reaches the
 * model. These fail on 0.2.58, which had no run_script.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { AgentLoop, type AgentEvent } from '../src/loop'
import { schema, str, userMsg, type Msg, type Tool, type ToolContext, type ToolResultBlock } from '../src/model'
import { providerFor } from '../src/providers/factory'
import { SCRIPT_PROMPT_LINE, SCRIPT_RESULT_CAP, formatOutcome, runScript, scriptTools, withScriptTools } from '../src/script'
import { startFakeAi, type FakeAi } from './fake-ai'

const servers: FakeAi[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentLabel: 'main',
    activity: async () => 1,
    updateActivity: async () => undefined,
    ask: async () => null,
    approve: async () => true,
    notify: async () => undefined,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function tool(name: string, run: Tool['run'], description = `${name}. More words here.`): Tool {
  return { spec: { name, description, schema: schema([], { id: str('id') }) }, run }
}

/** 20 projects with a secret in each, like a real list the model should never have to read. */
function projectTools(): { tools: Tool[]; models: Map<string, string> } {
  const models = new Map<string, string>()
  for (let i = 1; i <= 20; i++) models.set(`p${i}`, '')
  const tools = [
    tool('project_list', async () => JSON.stringify([...models.keys()].map((id) => ({ id, secret: `SECRET-${id}-${'x'.repeat(200)}` })))),
    tool('project_update', async (input) => {
      const id = String(input['project'])
      if (!models.has(id)) throw new Error(`no project ${id}`)
      models.set(id, String(input['model']))
      return `${id}: model ${String(input['model'])} (SECRET-UPDATE-${id})`
    }),
  ]
  return { tools, models }
}

async function run(code: string, tools: Tool[], extra: Partial<Parameters<typeof runScript>[0]> = {}) {
  return runScript({ code, tools, ctx: ctx(), timeoutMs: 10_000, ...extra })
}

describe('run_script', () => {
  it('calls many tools in one script and returns only the small summary', async () => {
    const { tools, models } = projectTools()
    const outcome = await run(
      `const all = await tools.project_list({});
       const done = await Promise.all(all.map((p) => tools.project_update({ project: p.id, model: 'big-model' })));
       return { updated: done.length, first: all[0].id }`,
      tools,
    )
    expect(outcome.ok).toBe(true)
    expect(JSON.parse(outcome.value ?? '')).toEqual({ updated: 20, first: 'p1' })
    expect([...models.values()].every((m) => m === 'big-model')).toBe(true)
    expect(outcome.calls).toHaveLength(21)
    const text = formatOutcome(outcome)
    expect(text).toContain('"updated":20')
    expect(text).toContain('21 tool calls')
    expect(text).toContain('project_update x20')
    expect(text).not.toContain('SECRET')
  })

  it('keeps intermediate results out of what goes to the model, through the real agent loop', async () => {
    const { tools } = projectTools()
    const fake = await startFakeAi((_body, index) =>
      index === 0
        ? {
            toolCalls: [
              {
                name: 'run_script',
                input: { code: `const all = await tools.project_list({}); for (const p of all) await tools.project_update({ project: p.id, model: 'm' }); return 'set ' + all.length` },
              },
            ],
          }
        : { text: 'Done' },
    )
    servers.push(fake)
    const loop = new AgentLoop({ provider: providerFor({ provider: 'openai', key: 'k', baseUrl: fake.url }), model: 'test', tools })
    const history: Msg[] = [userMsg('set the model on every project')]
    const events: AgentEvent[] = []
    const out = await loop.run('sys', history, ctx(), { onEvent: (event) => void events.push(event) })
    expect(out).toBe('Done')
    // The model was offered run_script next to the agent's own tools.
    const offered = (fake.requests[0]?.body['tools'] as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(offered).toEqual(expect.arrayContaining(['project_list', 'project_update', 'run_script', 'run_script_result']))
    // One tool step, and what the model read back is the summary only.
    const results = history.flatMap((m) => m.blocks.filter((b): b is ToolResultBlock => b.t === 'result'))
    expect(results).toHaveLength(1)
    expect(results[0]?.content).toContain('Result: set 20')
    const sent = JSON.stringify(fake.requests[1]?.body ?? {})
    expect(sent).toContain('set 20')
    expect(sent).not.toContain('SECRET')
    // The work trail saw every inner call, as ordinary tool steps.
    const inner = events.filter((e) => e.type === 'tool_finished' && e.call.name !== 'run_script')
    expect(inner).toHaveLength(21)
    expect(events.filter((e) => e.type === 'tool_started' && e.call.name === 'project_update')).toHaveLength(20)
  })

  it('reads several tools, filters and returns a decision', async () => {
    const people = [
      { name: 'Ann', height: 171 },
      { name: 'Bo', height: 158 },
      { name: 'Cy', height: 190 },
    ]
    const tools = [
      tool('people_list', async () => JSON.stringify(people.map((p) => p.name))),
      tool('person_get', async (input) => JSON.stringify(people.find((p) => p.name === input['id']))),
    ]
    const outcome = await run(
      `const names = await tools.people_list({});
       const rows = await Promise.all(names.map((id) => tools.person_get({ id })));
       return rows.reduce((a, b) => (a.height <= b.height ? a : b)).name`,
      tools,
    )
    expect(outcome.value).toBe('"Bo"')
  })

  it('an approval inside a script still asks the person and blocks until answered; a no is a no', async () => {
    const asked: string[] = []
    let answer: (ok: boolean) => void = () => undefined
    const approve = (summary: string): Promise<boolean> => {
      asked.push(summary)
      return new Promise((resolve) => {
        answer = resolve
      })
    }
    const sent: string[] = []
    const send = tool('mail_send', async (input, c) => {
      if (!(await c.approve(`Send mail to ${String(input['id'])}`))) return 'The user declined. Nothing was sent.'
      sent.push(String(input['id']))
      return 'Sent.'
    })
    const pending = runScript({ code: `return await tools.mail_send({ id: 'a@example.com' })`, tools: [send], ctx: ctx({ approve }), timeoutMs: 10_000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(asked).toEqual(['Send mail to a@example.com'])
    expect(sent).toEqual([]) // still waiting on the person
    answer(false)
    const outcome = await pending
    expect(outcome.value).toBe('"The user declined. Nothing was sent."')
    expect(sent).toEqual([])
  })

  it('cannot call run_script from inside a script', async () => {
    const all = withScriptTools([tool('now', async () => 'noon')])
    const runTool = all.find((t) => t.spec.name === 'run_script')
    const text = await runTool!.run({ code: `try { await tools.run_script({ code: 'return 1' }); return 'nested' } catch (e) { return e.message }` }, ctx())
    expect(text).toContain('cannot be called from inside a script')
  })

  it('a thrown inner tool error is catchable in the script', async () => {
    const outcome = await run(`try { await tools.boom({}) } catch (e) { return 'caught: ' + e.message }`, [tool('boom', async () => { throw new Error('kaput') })])
    expect(outcome.value).toBe('"caught: boom failed: kaput"')
  })

  it('returns errors as data with a stack and the partial log, never throws', async () => {
    const outcome = await run(`log('step one'); throw new Error('bad thing')`, [])
    expect(outcome.ok).toBe(false)
    const text = formatOutcome(outcome)
    const data = JSON.parse(text.slice(0, text.lastIndexOf('}') + 1)) as { error: string; stack: string; partialLog: string }
    expect(data.error).toBe('bad thing')
    expect(data.stack).toContain('script.js')
    expect(data.partialLog).toBe('step one')
    const syntax = await run(`return (`, [])
    expect(syntax.ok).toBe(false)
    expect(syntax.error).toMatch(/Unexpected|SyntaxError|end of input/i)
  })

  it('times out a script that never ends, a busy loop as well as a wait', async () => {
    const busy = await run(`while (true) {}`, [], { timeoutMs: 800 })
    expect(busy.ok).toBe(false)
    expect(busy.timedOut).toBe(true)
    const waiting = await run(`log('waiting'); await new Promise(() => {})`, [], { timeoutMs: 800 })
    expect(waiting.timedOut).toBe(true)
    expect(formatOutcome(waiting)).toContain('"partialLog": "waiting"')
  })

  it('gives a returned string back as its own lines, and anything else as JSON', async () => {
    expect(formatOutcome(await run(`return ['one', 'two', 'three'].join(String.fromCharCode(10))`, []))).toMatch(/^Result: one\ntwo\nthree\n/)
    expect(formatOutcome(await run(`return { a: 1 }`, []))).toMatch(/^Result: \{"a":1\}\n/)
  })

  it('caps the return value and the log', async () => {
    const outcome = await run(`for (let i = 0; i < 2000; i++) log('line ' + i + ' ' + 'y'.repeat(50)); return 'x'.repeat(50000)`, [])
    const text = formatOutcome(outcome)
    expect(text).toContain('[truncated: the result was 50000 chars')
    expect(text).toContain('[log truncated')
    expect(text.length).toBeLessThan(SCRIPT_RESULT_CAP + 4_000 + 1_000)
  })

  it('runs sealed: no require, process, eval or Function, only tools', async () => {
    const outcome = await run(
      `const out = { require: typeof require, process: typeof process, fs: typeof fs };
       try { eval('1'); out.eval = 'ran' } catch (e) { out.eval = 'blocked' }
       try { new Function('return 1')(); out.fn = 'ran' } catch (e) { out.fn = 'blocked' }
       try { out.escape = tools.constructor.constructor('return typeof process')() } catch (e) { out.escape = 'blocked' }
       return out`,
      [],
    )
    expect(JSON.parse(outcome.value ?? '')).toEqual({ require: 'undefined', process: 'undefined', fs: 'undefined', eval: 'blocked', fn: 'blocked', escape: 'blocked' })
  })

  it('lists and describes the tools so their schemas need not be in the prompt', async () => {
    const outcome = await run(`return { list: tools.$list(), one: tools.$describe('project_update') }`, projectTools().tools)
    const value = JSON.parse(outcome.value ?? '') as { list: Array<{ name: string; description: string }>; one: { name: string; arguments: unknown } }
    expect(value.list).toEqual([
      { name: 'project_list', description: 'project_list.' },
      { name: 'project_update', description: 'project_update.' },
    ])
    expect(value.one.name).toBe('project_update')
    expect(value.one.arguments).toMatchObject({ type: 'object' })
  })

  it('runs in the background and gives its result later', async () => {
    const [runTool, resultTool] = scriptTools({ tools: () => [tool('now', async () => 'noon')] })
    const started = await runTool!.run({ code: `await sleep(200); return await tools.now({})`, background: true }, ctx())
    const id = /scr_[a-z0-9]+/.exec(started)?.[0] ?? ''
    expect(id).not.toBe('')
    expect(await resultTool!.run({ id }, ctx())).toContain('still running')
    expect(await resultTool!.run({ id, wait_seconds: 5 }, ctx())).toContain('Result: noon')
    // Another agent cannot read it.
    expect(await resultTool!.run({ id }, ctx({ agentLabel: 'helper', owner: 'helper:9' }))).toContain('No background script')
  })

  it('has a prompt line every agent can be given', () => {
    expect(SCRIPT_PROMPT_LINE).toContain('more than two similar calls')
    expect(SCRIPT_PROMPT_LINE).toContain('tools.$list()')
  })
})
