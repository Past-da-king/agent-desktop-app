/**
 * The cross-origin iframe input probe.
 *
 * Opened with `AGENT_IFRAME_PROBE=<url of the outer page>` (the page from test/fixtures/iframe-origins.mjs, an outer
 * page holding a cross-origin iframe that holds another), the app opens it in its real agent browser and drives the
 * innermost frame the way an agent does: browser_act by point (click, type, key), then reads what the inner page saw
 * from the fixture's own log (`AGENT_IFRAME_PROBE_LOG`), and writes one JSON report (`AGENT_IFRAME_PROBE_OUT`) and quits.
 * It also reports whether the app ever said "the person is using this tab" for the agent's own input.
 */
import { appendFileSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface IframeProbeHost {
  probeOpen(url: string): Promise<string>
  act(request: { action: string; at?: { x: number; y: number }; key?: string; text?: string }): Promise<string>
  screenshot(): Promise<string | null>
  setExpanded?(on: boolean): void
}

interface Point {
  x: number
  y: number
}

export async function runIframeProbe(
  host: IframeProbeHost,
  url: string,
  logUrl: string,
  points: { button: Point; field: Point; editable: Point },
  out: string,
  quit: () => void,
  shotDir = '',
  expand = false,
): Promise<void> {
  const report: Record<string, unknown> = { url }
  const progress = (line: string): void => {
    if (out !== '') appendFileSync(`${out}.progress`, `${new Date().toISOString()} ${line}
`)
  }
  progress('start')
  const events = async (): Promise<Array<{ e: string; d: string }>> => {
    try {
      return (await (await fetch(logUrl)).json()) as Array<{ e: string; d: string }>
    } catch {
      return []
    }
  }
  const mark = async (): Promise<number> => (await events()).length
  const since = async (from: number): Promise<string[]> => (await events()).slice(from).map((e) => `${e.e}:${e.d}`)
  const paused = (text: string): boolean => text.startsWith('The person is using this tab')
  const shot = async (name: string): Promise<void> => {
    if (shotDir === '') return
    const path = await host.screenshot()
    if (typeof path === 'string' && path !== '') copyFileSync(path, `${shotDir}/${name}.png`)
  }
  try {
    if (expand) host.setExpanded?.(true)
    progress(`open: ${(await host.probeOpen(url)).slice(0, 300)}`)
    await sleep(2500)
    await shot('00-open')
    const steps: Array<[string, () => Promise<string>]> = [
      ['click button (by point)', () => host.act({ action: 'click', at: points.button })],
      ['click field (by point)', () => host.act({ action: 'click', at: points.field })],
      ['type into field', () => host.act({ action: 'type', at: points.field, text: 'hello' })],
      ['key PageDown', () => host.act({ action: 'press', key: 'PageDown' })],
      ['click editable (by point)', () => host.act({ action: 'click', at: points.editable })],
      ['key x', () => host.act({ action: 'press', key: 'x' })],
    ]
    const results: Array<Record<string, unknown>> = []
    let n = 0
    for (const [name, run] of steps) {
      const from = await mark()
      progress(`step ${name}`)
      const answer = await run()
      progress(`answer ${answer.slice(0, 120)}`)
      await sleep(600)
      n++
      await shot(`${String(n).padStart(2, '0')}-${name.replace(/[^a-z]+/gi, '-')}`)
      results.push({ step: name, personUsingMessage: paused(answer), events: await since(from) })
    }
    report['results'] = results
  } catch (error) {
    report['error'] = error instanceof Error ? error.message : String(error)
  }
  if (out !== '') writeFileSync(out, JSON.stringify(report, null, 2))
  console.log(`IFRAME PROBE ${JSON.stringify(report)}`)
  quit()
}

export interface BridgeHost {
  probeOpen(url: string): Promise<string>
  act(request: { action: string }): Promise<string>
  snapshot(): Promise<string>
  screenshot(): Promise<string | null>
  evaluate(code: string, seconds: number): Promise<string>
  setExpanded(on: boolean): void
  view(request: { mode?: 'desktop' | 'tablet' | 'phone' | 'fit'; width?: number; height?: number; remember?: boolean }): Promise<string>
}

/**
 * A command folder for the real-site proof (`AGENT_BROWSER_BRIDGE=<folder>`, never set in normal use): a file
 * `<id>.cmd.json` ({ "method": "act", "args": [{...}] }) is run through the app's own browser (the same methods the
 * agent's browser tools call) and the answer is written to `<id>.res.json`. Lets a proof drive a signed-in site in
 * a test copy of the app with no other path in.
 */
export function runBrowserBridge(host: BridgeHost, dir: string): void {
  const done = new Set<string>()
  const busy = { on: false }
  const tick = async (): Promise<void> => {
    if (busy.on) return
    busy.on = true
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.cmd.json') || done.has(name)) continue
        done.add(name)
        const base = name.slice(0, -'.cmd.json'.length)
        let result: unknown
        try {
          const cmd = JSON.parse(readFileSync(`${dir}/${name}`, 'utf8')) as { method: string; args?: unknown[] }
          const args = cmd.args ?? []
          switch (cmd.method) {
            case 'probeOpen': result = await host.probeOpen(String(args[0])); break
            case 'act': result = await host.act(args[0] as { action: string }); break
            case 'snapshot': result = await host.snapshot(); break
            case 'screenshot': result = await host.screenshot(); break
            case 'evaluate': result = await host.evaluate(String(args[0]), Number(args[1] ?? 20)); break
            case 'view': result = await host.view(args[0] as { width?: number; height?: number; remember?: boolean }); break
            case 'expand': host.setExpanded(args[0] !== false); result = 'ok'; break
            default: result = `unknown method ${cmd.method}`
          }
        } catch (error) {
          result = `ERROR ${error instanceof Error ? error.message : String(error)}`
        }
        writeFileSync(`${dir}/${base}.res.json`, JSON.stringify({ result }))
      }
    } finally {
      busy.on = false
    }
  }
  setInterval(() => void tick(), 300)
}
