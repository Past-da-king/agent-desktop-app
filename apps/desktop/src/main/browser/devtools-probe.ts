/**
 * The real-Electron proof of the developer tools: after the probe page opens (AGENT_BROWSER_PROBE_URL),
 * runs each tool the agent has against the live tab and prints what the model would read. Only index.ts
 * calls it, only when AGENT_DEVTOOLS_PROBE=1; never in normal use.
 */
import type { JsonObject } from '@agent/core'

import { browserDevtoolsTools } from '../tools/browser-devtools'
import type { AgentBrowser } from './browser'
import { devtoolsOf } from './devtools'

const noop = async (): Promise<undefined> => undefined

export async function runDevtoolsProbe(browser: AgentBrowser): Promise<void> {
  const tools = browserDevtoolsTools({ devtools: () => devtoolsOf(browser) })
  const ctx = {
    agentLabel: 'probe',
    activity: async () => 0,
    updateActivity: noop,
    ask: async () => null,
    approve: async () => false,
    notify: noop,
    signal: new AbortController().signal,
  }
  const run = async (name: string, input: JsonObject = {}): Promise<string> => {
    const tool = tools.find((t) => t.spec.name === name)
    if (tool === undefined) return `no tool ${name}`
    const out = await tool.run(input, ctx)
    // The model may read cookie values; a log never shows them.
    const shown = name === 'browser_storage' ? out.replace(/^(\s+[^=\s]+=)(.*?)(?=  \(domain )/gm, '$1[value hidden in this log]') : out
    console.log(`\n===== DEVTOOLS PROBE ${name} ${JSON.stringify(input)}\n${shown}`)
    return out
  }
  const env = (key: string, fallback: string): string => process.env[key]?.trim() || fallback
  // Let the page finish its own calls first.
  await new Promise((resolve) => setTimeout(resolve, Number(env('AGENT_DEVTOOLS_PROBE_WAIT_MS', '3000'))))

  await run('browser_network', { limit: 25 })
  const api = await run('browser_network', { api: true, url: env('AGENT_DEVTOOLS_PROBE_API', '') })
  // The first API call that answered with JSON, to read in full and replay.
  const ids = [...api.matchAll(/^(r\d+) (GET|POST) 200 (?:xhr|fetch) application\/json/gm)].map((m) => m[1] ?? '')
  const first = ids[0]
  if (first !== undefined) {
    await run('browser_network_get', { id: first, max: 1500 })
    await run('browser_fetch', { from: first, max: 800 })
  }
  const post = process.env['AGENT_DEVTOOLS_PROBE_POST']?.trim() ?? ''
  if (post !== '') await run('browser_fetch', { url: post, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"user":"probe","remember":false}' })
  await run('browser_console', { limit: 30 })
  await run('browser_console', { level: 'error' })
  console.log(`\n===== DEVTOOLS PROBE browser_eval\n${await browser.evaluate(env('AGENT_DEVTOOLS_PROBE_EVAL', '({ title: document.title, links: document.links.length, ok: await Promise.resolve(42) })'), 10)}`)
  console.log(`\n===== DEVTOOLS PROBE browser_eval (a throw)\n${await browser.evaluate("throw new TypeError('probe threw on purpose')", 10)}`)
  await run('browser_inspect', { selector: env('AGENT_DEVTOOLS_PROBE_SELECTOR', 'button'), limit: 2, html: 300 })
  await run('browser_storage', { max: 40 })

  // The person's Developer tools button: Chromium's DevTools in its own window, and recording carries on.
  browser.openDevTools()
  const wc = browser.devtoolsTarget()
  const opened = Date.now()
  while (wc?.isDevToolsOpened() !== true && Date.now() - opened < 10_000) await new Promise((resolve) => setTimeout(resolve, 200))
  // Let the DevTools window paint before the picture is taken.
  await new Promise((resolve) => setTimeout(resolve, 2500))
  console.log(`\n===== DEVTOOLS PROBE openDevTools\nDevTools open: ${wc?.isDevToolsOpened() === true} after ${Date.now() - opened} ms`)
  const shot = process.env['AGENT_DEVTOOLS_PROBE_SHOT']?.trim() ?? ''
  const front = wc?.devToolsWebContents
  if (shot !== '' && front !== null && front !== undefined) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(shot, (await front.capturePage()).toPNG())
    console.log(`DevTools window saved to ${shot}`)
  }
  await browser.evaluate("fetch(location.origin + '/?after-devtools=1').then(() => console.log('after devtools opened'))", 10)
  await new Promise((resolve) => setTimeout(resolve, 1000))
  await run('browser_network', { url: 'after-devtools' })
  await run('browser_console', { text: 'after devtools' })
  console.log('\nDEVTOOLS PROBE done')
}
