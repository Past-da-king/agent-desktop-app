/**
 * The real-Electron typist proof of the agent's own browser (11 Nov 2026, part 5 of docs/agent-cursor.md). Only index.ts calls
 * it, only when AGENT_TYPING_PROBE names a spec file; never in normal use.
 *
 * A script outside the app types thousands of characters into a window of its own while this runs a form in the agent's
 * browser (text, password, select, tick, file, submit) through the same AgentBrowser.act and upload the tools use. The
 * script checks that its text arrived whole and that his pointer and foreground never changed. This file only drives the
 * browser and writes what each step answered; the page itself reports what it received.
 *
 * Spec: { url, goFile, out, steps: [{ op: 'act', request: ActRequest } | { op: 'upload', target, paths } | { op: 'wait', ms }] }
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import type { AgentBrowser } from './browser'
import type { ActRequest } from './types'
import type { UploadTarget } from './upload'

type Step = { op: 'act'; request: ActRequest } | { op: 'upload'; target: UploadTarget; paths: string[] } | { op: 'wait'; ms: number }

interface Spec {
  goFile: string
  out: string
  steps: Step[]
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function runTypingProbe(browser: AgentBrowser, specPath: string): Promise<void> {
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as Spec
  const results: Array<{ step: number; at: number; answer: string }> = []
  const started = Date.now()
  // The typist writes goFile when it has started typing; the form is filled while it types.
  while (!existsSync(spec.goFile) && Date.now() - started < 120_000) await sleep(100)
  for (const [i, step] of spec.steps.entries()) {
    const at = Date.now()
    let answer = ''
    try {
      if (step.op === 'wait') await sleep(step.ms)
      else if (step.op === 'act') answer = await browser.act(step.request)
      else answer = await browser.upload(step.target, step.paths)
    } catch (error) {
      answer = `THREW ${error instanceof Error ? error.message : String(error)}`
    }
    results.push({ step: i, at, answer: answer.slice(0, 300) })
    writeFileSync(spec.out, JSON.stringify({ done: false, results }, null, 2))
    await sleep(400)
  }
  writeFileSync(spec.out, JSON.stringify({ done: true, results }, null, 2))
}
