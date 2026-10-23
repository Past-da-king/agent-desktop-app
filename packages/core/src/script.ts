/**
 * Programmatic tool calling (23 Oct 2026): the agent writes ONE short script instead of calling tools one by one.
 *
 * Inside the script every tool the agent has is a plain async function, `tools.<name>(args)`, so loops, filters,
 * Promise.all and conditionals work, and the intermediate results never reach the model: only the script's small
 * return value and a capped log do.
 *
 * Safety is unchanged because the script never touches a tool itself. It runs in a worker thread, inside a sealed
 * vm context with no require, process, eval or host objects; its only way out is a bridge that posts the tool's name
 * and JSON arguments back to this thread, where the call runs through the SAME Tool object and the SAME ToolContext
 * the agent's own call would: approval cards, question cards, the commands-and-files choice and the profile gate all
 * apply and block until answered. run_script is not available inside itself.
 */
import { Worker } from 'node:worker_threads'

import type { JsonObject, Tool, ToolCallBlock, ToolContext } from './model'
import { bool, clipResult, int, schema, str } from './model'

export const SCRIPT_TOOL = 'run_script'
export const SCRIPT_RESULT_TOOL = 'run_script_result'
/** What a script may not call: itself (no recursion). Reading a background result from inside one is harmless. */
const NOT_INSIDE: ReadonlySet<string> = new Set([SCRIPT_TOOL])

export const SCRIPT_DEFAULT_SECONDS = 120
export const SCRIPT_MAX_SECONDS = 600
export const SCRIPT_BACKGROUND_DEFAULT_SECONDS = 600
export const SCRIPT_BACKGROUND_MAX_SECONDS = 3600
/** The most of the return value the model reads. */
export const SCRIPT_RESULT_CAP = 12_000
/** The most of the log the model reads. */
export const SCRIPT_LOG_CAP = 4_000
/** Inner calls running at once (Promise.all over 200 items must not start 200 browser tabs). */
export const SCRIPT_PARALLEL = 8
/**
 * What one inner result may hand the script. Each inner call runs with this as its ToolContext.resultLimit, so a tool
 * that trims its result for a model (a connected app's 20,000 characters) gives a script the whole of it. Only a
 * result past this (a page dump of tens of MB would stall the worker) is cut, and then as a valid object with
 * truncated: true, never as broken JSON.
 */
export const SCRIPT_INNER_RESULT_CAP = 4_000_000
/** What one inner result shows in the work trail, the same as an ordinary call. */
const TRAIL_CLIP = 24_000

/** The prompt paragraph every agent gets (main, project chats, routines, helpers, offloaded runs). */
export const SCRIPT_PROMPT_LINE =
  '- BATCH WITH run_script. For any job with more than two similar calls, or any call whose result only feeds a decision, write one run_script instead of calling tools one by one. Inside it, tools.<name>(args) calls any tool (it returns the parsed JSON, or the text); tools.$list() and tools.$describe(name) show what exists and its arguments. Use loops, filters and Promise.all; log() and sleep() are there too. Return only the small summary you need: that return value is all you read. Approvals and the user\'s rules still apply to every call inside.'

/** One inner call as the trail and the summary line see it. */
export interface ScriptCall {
  id: string
  name: string
  args: string
  ok: boolean
  ms: number
}

export interface ScriptOutcome {
  ok: boolean
  /** The return value as JSON text, when ok. */
  value?: string
  error?: string
  stack?: string
  log: string[]
  calls: ScriptCall[]
  ms: number
  timedOut?: boolean
}

/** Lets the work trail show each inner call as it happens, exactly like an ordinary call. */
export interface ScriptEvents {
  started?(call: ToolCallBlock): void | Promise<void>
  finished?(call: ToolCallBlock, result: string, isError: boolean): void | Promise<void>
}

export interface RunScriptOptions {
  code: string
  tools: Tool[]
  ctx: ToolContext
  timeoutMs: number
  id?: string
  events?: ScriptEvents
  /** Stops the script (Stop pressed, or run_script_result stop). */
  signal?: AbortSignal
}

/**
 * The worker: CommonJS, evaluated from a string. Only it ever sees require; the agent's code runs in a context
 * whose globals are made by BOOT from primitives, with eval and new Function switched off.
 */
const BOOT = `(function (b, specsJson) {
  'use strict';
  const specs = JSON.parse(specsJson);
  const parse = (t) => { try { const v = JSON.parse(t); if (v !== null && typeof v === 'object') return v; } catch (e) {} return t; };
  const call = (name, args) => new Promise((res, rej) => {
    let json;
    try { json = JSON.stringify(args === undefined ? {} : args); } catch (e) { rej(new Error('The arguments for ' + name + ' are not JSON: ' + e.message)); return; }
    if (json === undefined || json[0] !== '{') { rej(new Error('Pass ' + name + ' one object of arguments, e.g. tools.' + name + '({ ... }).')); return; }
    b('call', name, json, (t) => res(parse(t)), (m) => { const e = new Error(m); e.tool = name; rej(e); });
  });
  const list = () => specs.map((s) => ({ name: s.name, description: s.line }));
  const describe = (name) => {
    const s = specs.find((x) => x.name === name);
    if (!s) throw new Error('There is no tool ' + name + '. tools.$list() shows them.');
    return JSON.parse(JSON.stringify({ name: s.name, description: s.description, arguments: s.schema }));
  };
  const tools = new Proxy(Object.create(null), {
    get(_, key) {
      if (key === '$list') return list;
      if (key === '$describe') return describe;
      if (typeof key !== 'string' || key === 'then') return undefined;
      return (args) => call(key, args);
    },
    has(_, key) { return specs.some((s) => s.name === key); },
    ownKeys() { return specs.map((s) => s.name); },
    getOwnPropertyDescriptor(_, key) { return specs.some((s) => s.name === key) ? { enumerable: true, configurable: true, value: (args) => call(key, args) } : undefined; },
  });
  const fmt = (v) => { if (typeof v === 'string') return v; if (v instanceof Error) return v.message; try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (e) { return String(v); } };
  const log = (...a) => { b('log', a.map(fmt).join(' ')); };
  const sleep = (ms) => new Promise((res) => b('sleep', String(Number(ms) || 0), () => res(undefined)));
  return { tools, log, sleep, console: { log, info: log, warn: log, error: log, debug: log } };
})`

const WORKER = `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const pending = new Map();
let seq = 0;
const bridge = (kind, a, b2, res, rej) => {
  if (kind === 'call') {
    const id = ++seq;
    pending.set(id, { res, rej });
    parentPort.postMessage({ type: 'call', id, name: String(a), args: String(b2) });
  } else if (kind === 'log') {
    parentPort.postMessage({ type: 'log', text: String(a).slice(0, 2000) });
  } else if (kind === 'sleep') {
    setTimeout(() => b2(), Math.max(0, Math.min(Number(a) || 0, 3600000)));
  }
};
parentPort.on('message', (m) => {
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.res(String(m.text)); else p.rej(String(m.message));
});
const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, name: 'run_script' });
const api = vm.runInContext(${JSON.stringify(BOOT)}, context)(bridge, workerData.specs);
context.tools = api.tools; context.log = api.log; context.sleep = api.sleep; context.console = api.console;
const done = (v) => {
  let text;
  try { text = JSON.stringify(v === undefined ? null : v); } catch (e) { text = JSON.stringify(String(v)); }
  parentPort.postMessage({ type: 'done', value: text === undefined ? 'null' : text });
};
const fail = (e) => {
  const message = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
  const stack = e && typeof e === 'object' && 'stack' in e ? String(e.stack).split('\\n').slice(0, 8).join('\\n') : '';
  parentPort.postMessage({ type: 'error', message, stack });
};
try {
  const p = vm.runInContext('(async () => {\\n' + workerData.code + '\\n})()', context, { filename: 'script.js', timeout: workerData.timeout });
  Promise.resolve(p).then(done, fail);
} catch (e) { fail(e); }
`

/** The first line of a description: what $list shows. */
function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? ''
  const sentence = line.match(/^.*?[.!?](\s|$)/)?.[0] ?? line
  return sentence.trim().slice(0, 200)
}

function argsSummary(json: string): string {
  const flat = json.replace(/\s+/g, ' ')
  return flat.length <= 160 ? flat : `${flat.slice(0, 157)}...`
}

let scriptSeq = 0

/** Runs one script to the end (or its timeout) and gives back what happened. Never throws. */
export function runScript(options: RunScriptOptions): Promise<ScriptOutcome> {
  const started = Date.now()
  const id = options.id ?? `s${Date.now().toString(36)}${(scriptSeq += 1)}`
  const usable = options.tools.filter((tool) => !NOT_INSIDE.has(tool.spec.name))
  const byName = new Map(usable.map((tool) => [tool.spec.name, tool]))
  const specs = usable.map((tool) => ({ name: tool.spec.name, line: firstLine(tool.spec.description), description: tool.spec.description, schema: tool.spec.schema }))
  const log: string[] = []
  let logSize = 0
  let logDropped = 0
  const calls: ScriptCall[] = []
  // Inner calls hand the script their whole result: a tool's own trim is sized for a model, not for code.
  const innerCtx: ToolContext = { ...options.ctx, resultLimit: SCRIPT_INNER_RESULT_CAP }
  let callSeq = 0
  let active = 0
  const queue: Array<() => void> = []

  return new Promise<ScriptOutcome>((resolve) => {
    let settled = false
    let worker: Worker
    try {
      worker = new Worker(WORKER, {
        eval: true,
        env: {},
        stdout: true,
        stderr: true,
        workerData: { code: options.code, specs: JSON.stringify(specs), timeout: options.timeoutMs },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      })
    } catch (error) {
      resolve({ ok: false, error: `The script could not start: ${error instanceof Error ? error.message : String(error)}`, log, calls, ms: 0 })
      return
    }
    const finish = (outcome: Omit<ScriptOutcome, 'log' | 'calls' | 'ms'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      void worker.terminate()
      if (logDropped > 0) log.push(`[log cut: ${logDropped} more lines]`)
      resolve({ ...outcome, log, calls, ms: Date.now() - started })
    }
    const timer = setTimeout(() => {
      finish({ ok: false, timedOut: true, error: `The script ran out of time after ${Math.round(options.timeoutMs / 1000)} s. Calls already made stay done. Do less per script, or pass background true for a long job.` })
    }, options.timeoutMs)
    const onAbort = (): void => finish({ ok: false, error: 'The script was stopped.' })
    if (options.signal?.aborted === true) {
      onAbort()
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const reply = (message: JsonObject): void => {
      if (!settled) worker.postMessage(message)
    }
    const slot = (): Promise<void> =>
      active < SCRIPT_PARALLEL
        ? Promise.resolve().then(() => {
            active += 1
          })
        : new Promise<void>((go) => queue.push(() => {
            active += 1
            go()
          }))
    const release = (): void => {
      active -= 1
      queue.shift()?.()
    }

    const runCall = async (callId: number, name: string, argsJson: string): Promise<void> => {
      const tool = byName.get(name)
      if (tool === undefined) {
        const why = NOT_INSIDE.has(name) ? `${name} cannot be called from inside a script.` : `There is no tool ${name}. tools.$list() shows the tools you have.`
        calls.push({ id: `${id}.${callId}`, name, args: argsSummary(argsJson), ok: false, ms: 0 })
        reply({ id: callId, ok: false, message: why })
        return
      }
      let input: JsonObject
      try {
        const parsed = JSON.parse(argsJson) as unknown
        input = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonObject) : {}
      } catch {
        input = {}
      }
      await slot()
      if (settled) {
        release()
        return
      }
      const call: ToolCallBlock = { t: 'call', id: `${id}.${(callSeq += 1)}`, name, input }
      const t0 = Date.now()
      try {
        await options.events?.started?.(call)
      } catch {
        // The trail failing to draw must never fail the call.
      }
      let text: string
      let ok = true
      try {
        text = await tool.run(input, innerCtx)
      } catch (error) {
        ok = false
        text = error instanceof Error ? error.message || error.name : String(error)
      } finally {
        release()
      }
      const ms = Date.now() - t0
      calls.push({ id: call.id, name, args: argsSummary(argsJson), ok, ms })
      try {
        const shown = ok ? text : `Error: ${text}`
        await options.events?.finished?.(call, shown.length > TRAIL_CLIP ? `${shown.slice(0, TRAIL_CLIP)}\n...(cut, ${shown.length} chars total)` : shown, !ok)
      } catch {
        // as above
      }
      if (ok) {
        reply({ id: callId, ok: true, text: clipResult(text, SCRIPT_INNER_RESULT_CAP) })
      } else {
        reply({ id: callId, ok: false, message: `${name} failed: ${text}` })
      }
    }

    worker.on('message', (message: { type: string; id?: number; name?: string; args?: string; text?: string; value?: string; message?: string; stack?: string }) => {
      if (settled) return
      switch (message.type) {
        case 'call':
          void runCall(message.id ?? 0, message.name ?? '', message.args ?? '{}')
          return
        case 'log': {
          const line = message.text ?? ''
          if (logSize + line.length > SCRIPT_LOG_CAP * 2) {
            logDropped += 1
            return
          }
          logSize += line.length + 1
          log.push(line)
          return
        }
        case 'done':
          finish({ ok: true, value: message.value ?? 'null' })
          return
        case 'error':
          finish({ ok: false, error: message.message ?? 'The script failed.', ...(message.stack ? { stack: message.stack } : {}) })
          return
      }
    })
    worker.on('error', (error: Error & { code?: string }) => {
      const why = error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'The script used too much memory (256 MB). Keep less in memory: summarise as you go.' : error.message
      finish({ ok: false, error: why })
    })
    worker.on('exit', () => finish({ ok: false, error: 'The script ended without returning.' }))
  })
}

function capLog(lines: string[]): string {
  let out = ''
  let shown = 0
  for (const line of lines) {
    if (out.length + line.length + 1 > SCRIPT_LOG_CAP) break
    out += `${line}\n`
    shown += 1
  }
  if (shown < lines.length) out += `[log truncated: ${lines.length - shown} more lines not shown]\n`
  return out.trimEnd()
}

/** "21 calls in 3.4 s (project_update x20, project_list x1); all ok." */
export function callsLine(outcome: ScriptOutcome): string {
  if (outcome.calls.length === 0) return `No tool calls; ${(outcome.ms / 1000).toFixed(1)} s.`
  const counts = new Map<string, number>()
  for (const call of outcome.calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  const names = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => (n === 1 ? name : `${name} x${n}`))
  const failed = outcome.calls.filter((call) => !call.ok).length
  return `${outcome.calls.length} tool call${outcome.calls.length === 1 ? '' : 's'} in ${(outcome.ms / 1000).toFixed(1)} s (${names.join(', ')}${counts.size > 8 ? ', ...' : ''}); ${failed === 0 ? 'all ok' : `${failed} failed`}.`
}

/** What the model reads: the return value (capped), the log (capped) and one line about the calls. */
export function formatOutcome(outcome: ScriptOutcome): string {
  const log = capLog(outcome.log)
  if (!outcome.ok) {
    const data: JsonObject = { error: outcome.error ?? 'The script failed.' }
    if (outcome.stack !== undefined && outcome.stack !== '') data['stack'] = outcome.stack
    if (outcome.timedOut === true) data['timedOut'] = true
    data['partialLog'] = log
    return `${JSON.stringify(data, null, 1)}\n${callsLine(outcome)}`
  }
  // A returned string reads as itself (its own lines), anything else as JSON.
  let value = outcome.value ?? 'null'
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed === 'string') value = parsed
  } catch {
    // not JSON: shown as it is
  }
  const shown = value.length > SCRIPT_RESULT_CAP ? `${value.slice(0, SCRIPT_RESULT_CAP)}\n...[truncated: the result was ${value.length} chars; return a smaller summary]` : value
  return [`Result: ${shown}`, ...(log === '' ? [] : ['Log:', log]), callsLine(outcome)].join('\n')
}

// ---- what the work trail shows ------------------------------------------------------------------------------

/**
 * The outcome of a finished script, kept against the very input object it was called with, so the activity row for
 * that call can list its inner calls (name, arguments, ok or failed, time) without the model ever reading them.
 */
const outcomes = new WeakMap<object, ScriptOutcome>()

/** The outcome run_script kept for this call's input, once. */
export function takeScriptOutcome(input: object): ScriptOutcome | undefined {
  const outcome = outcomes.get(input)
  outcomes.delete(input)
  return outcome
}

/** The inner calls as lines for a person: "ok  project_update  {"project":"p1"}  12 ms". */
export function callLines(outcome: ScriptOutcome, limit = 200): string {
  const lines = outcome.calls.slice(0, limit).map((call) => `${call.ok ? 'ok    ' : 'FAILED'}  ${call.name}  ${call.args}  ${call.ms} ms`)
  if (outcome.calls.length > limit) lines.push(`... and ${outcome.calls.length - limit} more`)
  return lines.join('\n')
}

// ---- background scripts ------------------------------------------------------------------------------------

interface Job {
  id: string
  owner: string
  started: number
  controller: AbortController
  promise: Promise<ScriptOutcome>
  outcome?: ScriptOutcome
}

const jobs = new Map<string, Job>()
const MAX_JOBS = 100

function remember(job: Job): void {
  jobs.set(job.id, job)
  if (jobs.size <= MAX_JOBS) return
  for (const [key, old] of jobs) {
    if (old.outcome !== undefined) {
      jobs.delete(key)
      if (jobs.size <= MAX_JOBS) return
    }
  }
}

function ownerOf(ctx: ToolContext): string {
  return ctx.owner ?? ctx.agentLabel
}

function seconds(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : fallback
  return Math.min(n, max)
}

export interface ScriptToolOptions {
  /** The tools the script may call: the very list the agent itself has (run_script is left out inside). */
  tools: () => Tool[]
  events?: ScriptEvents
}

/** run_script and run_script_result, bound to one agent's tools and work trail. */
export function scriptTools(options: ScriptToolOptions): Tool[] {
  const runTool: Tool = {
    spec: {
      name: SCRIPT_TOOL,
      description:
        'Run a short JavaScript async function body that calls your tools in code and returns ONE small result. Use it for any job with more than two similar calls (set something on every project, read ten pages, check twenty mails) or when results only feed a decision (find the smallest, the newest, the ones that match). Inside: `await tools.<name>({...})` calls any of your tools (returns the parsed JSON, or the text), `tools.$list()` lists them with one line each, `tools.$describe(name)` gives one tool\'s arguments; `log(...)` and `sleep(ms)` help. Loops, filters, Promise.all and try/catch work (a failed call throws, catchable). `return` the summary you need: only that (up to 12,000 chars) and the log (up to 4,000) come back to you. No require, files or network except through tools. Approvals and the user\'s rules apply to every call inside. Example: `const all = await tools.project_list({}); return all.split("\\n").filter(l => l.includes("(id ")).length`.',
      schema: schema(['code'], {
        code: str('The body of an async function: statements ending in return. Do not wrap it in a function.'),
        timeout_seconds: int(`How long it may run: default ${SCRIPT_DEFAULT_SECONDS}, at most ${SCRIPT_MAX_SECONDS} (${SCRIPT_BACKGROUND_MAX_SECONDS} in the background)`),
        background: bool('True for a long job: it starts, you get an id at once, and run_script_result gives the result later'),
      }),
    },
    run: async (input, ctx) => {
      const code = typeof input['code'] === 'string' ? input['code'] : ''
      if (code.trim() === '') return 'Pass code: the body of an async function that ends with return.'
      const background = input['background'] === true
      const timeoutMs = 1000 * (background ? seconds(input['timeout_seconds'], SCRIPT_BACKGROUND_DEFAULT_SECONDS, SCRIPT_BACKGROUND_MAX_SECONDS) : seconds(input['timeout_seconds'], SCRIPT_DEFAULT_SECONDS, SCRIPT_MAX_SECONDS))
      const tools = options.tools()
      if (!background) {
        const outcome = await runScript({ code, tools, ctx, timeoutMs, signal: ctx.signal, ...(options.events === undefined ? {} : { events: options.events }) })
        outcomes.set(input, outcome)
        return formatOutcome(outcome)
      }
      const id = `scr_${Date.now().toString(36)}${(scriptSeq += 1)}`
      const controller = new AbortController()
      const promise = runScript({ code, tools, ctx, timeoutMs, id, signal: controller.signal, ...(options.events === undefined ? {} : { events: options.events }) })
      const job: Job = { id, owner: ownerOf(ctx), started: Date.now(), controller, promise }
      void promise.then((outcome) => {
        job.outcome = outcome
      })
      remember(job)
      return `Started in the background as ${id} (up to ${Math.round(timeoutMs / 1000)} s). Get its result with run_script_result { "id": "${id}" } (wait_seconds waits for it).`
    },
  }
  const resultTool: Tool = {
    spec: {
      name: SCRIPT_RESULT_TOOL,
      description: 'The result of a run_script started with background true: still running, or its return value and log. wait_seconds waits up to that long for it to finish; stop true stops it.',
      schema: schema(['id'], {
        id: str('The id run_script gave back'),
        wait_seconds: int('Wait up to this long for it to finish (at most 120). Leave out to check at once.'),
        stop: bool('True stops it'),
      }),
    },
    run: async (input, ctx) => {
      const id = typeof input['id'] === 'string' ? input['id'].trim() : ''
      const job = jobs.get(id)
      if (job === undefined || job.owner !== ownerOf(ctx)) return `No background script ${id}.`
      if (input['stop'] === true && job.outcome === undefined) job.controller.abort()
      const wait = seconds(input['wait_seconds'], 0, 120)
      if (job.outcome === undefined && (wait > 0 || input['stop'] === true)) {
        await Promise.race([job.promise, new Promise((go) => setTimeout(go, input['stop'] === true ? 5000 : wait * 1000))])
      }
      const outcome = job.outcome ?? (await Promise.race([job.promise, Promise.resolve(undefined)]))
      if (outcome === undefined) return `${id} is still running (${Math.round((Date.now() - job.started) / 1000)} s so far).`
      outcomes.set(input, outcome)
      return formatOutcome(outcome)
    },
  }
  return [runTool, resultTool]
}

/** The tools plus run_script over them, unless they already have it. The script's tools are the same list. */
export function withScriptTools(tools: Tool[], events?: ScriptEvents): Tool[] {
  if (tools.some((tool) => tool.spec.name === SCRIPT_TOOL)) return tools
  const all: Tool[] = [...tools]
  all.push(...scriptTools({ tools: () => all, ...(events === undefined ? {} : { events }) }))
  return all
}
