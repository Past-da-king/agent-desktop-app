#!/usr/bin/env node
/**
 * Decision eval harness: node scripts/decisions-eval.mjs [--data file.jsonl] [--backend gemini|jev|openai] [--model id]
 *   [--target 0.95] [--concurrency 4] [--limit N] [--json out.json] [--url address] [--observations saved.json]
 * The key is read from the environment, never from a file: GEMINI_API_KEY, OPENAI_API_KEY, or JEV_API_KEY (an OpenRouter key).
 * --simulate runs a local stand-in model instead of a network call, to check the harness itself (the numbers mean nothing).
 * The example format is in apps/desktop/src/main/decisions/eval.ts; a synthetic seed set is in apps/desktop/test/fixtures/decisions.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Map()
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (!a.startsWith('--')) continue
  const next = process.argv[i + 1]
  if (next === undefined || next.startsWith('--')) args.set(a.slice(2), true)
  else {
    args.set(a.slice(2), next)
    i++
  }
}
const backend = String(args.get('backend') ?? 'gemini')
const data = resolve(String(args.get('data') ?? join(root, 'apps/desktop/test/fixtures/decisions/seed.jsonl')))
const out = mkdtempSync(join(tmpdir(), 'decisions-eval-'))
const bundle = join(out, 'harness.mjs')
await build({ entryPoints: [join(root, 'apps/desktop/src/main/decisions/eval-entry.ts')], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' })
const h = await import(pathToFileURL(bundle).href)

// --observations file.json: summarize a run made elsewhere (for example from a machine the key is allowed on): { observations: [{example, question, type, correct, confidence}], latenciesMs: [] }.
if (typeof args.get('observations') === 'string') {
  const saved = JSON.parse(readFileSync(resolve(String(args.get('observations'))), 'utf8'))
  const run = { observations: saved.observations, failures: [], missing: 0, latenciesMs: saved.latenciesMs ?? [] }
  console.log(h.formatReport(h.summarize(run, { target: Number(args.get('target') ?? 0.95) })))
  process.exit(0)
}

const keyName = { gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', jev: 'JEV_API_KEY' }[backend]
if (keyName === undefined) throw new Error('--backend must be gemini, jev or openai')
const key = process.env[keyName] ?? ''
const fetchImpl = (url, init) => fetch(url, init)
const model = typeof args.get('model') === 'string' ? args.get('model') : undefined
const url = typeof args.get('url') === 'string' ? args.get('url') : undefined
const extra = { ...(model === undefined ? {} : { model }), ...(url === undefined ? {} : { url }) }
const make = { gemini: h.geminiProvider, jev: h.jevProvider, openai: h.openAiProvider }[backend]
let provider = make({ key: () => (key === '' ? null : key), fetchImpl, ...extra })
if (args.get('simulate') === true) {
  // A stand-in: right 90% of the time, more sure when right. It only proves the harness runs.
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  provider = {
    id: backend,
    async decide(input, questions) {
      const answers = {}
      const text = typeof input === 'string' ? input : ''
      for (const [id, q] of Object.entries(questions)) {
        const p = Math.min(0.99, 0.5 + rnd() * 0.5)
        if (q.type === 'noul') answers[id] = { type: 'noul', value: p >= 0.5 && text.length % 2 === 0, probability: p, confidence: p }
        else if (q.type === 'choice') {
          const keys = Object.keys(q.options)
          answers[id] = { type: 'choice', value: keys[Math.floor(rnd() * keys.length)], probabilities: {}, confidence: p }
        } else answers[id] = { type: 'score', value: 0, level: 0, probabilities: [1], confidence: p }
      }
      return { answers, refused: [] }
    },
  }
} else if (key === '') {
  console.error(`Set ${keyName} (the key is never read from a file) or pass --simulate.`)
  process.exit(2)
}

const { examples, errors } = h.parseExamples(readFileSync(data, 'utf8'))
if (errors.length > 0) console.error('Example file problems:\n  ' + errors.join('\n  '))
const limit = Number(args.get('limit') ?? 0)
const chosen = limit > 0 ? examples.slice(0, limit) : examples
console.log(`Backend ${backend}${args.get('simulate') === true ? ' (SIMULATED)' : ''}, ${chosen.length} examples from ${data}`)
const run = await h.runEval(provider, chosen, { concurrency: Number(args.get('concurrency') ?? 4) })
const report = h.summarize(run, { target: Number(args.get('target') ?? 0.95) })
console.log(h.formatReport(report))
if (run.failures.length > 0) console.log('\nFirst failures: ' + run.failures.slice(0, 3).map((f) => f.example + ': ' + f.error).join(' | '))
if (typeof args.get('json') === 'string') writeFileSync(String(args.get('json')), JSON.stringify({ backend, report, failures: run.failures }, null, 2))
