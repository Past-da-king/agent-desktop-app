#!/usr/bin/env node
// A stand-in for tools/agent-screen in tests: the same JSON lines, a made-up screen.
// FAKE_SCREEN_LOG: a file it appends every request and its start and stop to.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const log = process.env.FAKE_SCREEN_LOG ?? ''
const note = (entry) => {
  if (log !== '') appendFileSync(log, `${JSON.stringify(entry)}\n`)
}
const say = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)
const ok = (id, result) => say({ id, ok: true, ms: 1, result })
const fail = (id, code, error) => say({ id, ok: false, code, error })

const monitor = { device: '\\\\.\\DISPLAY1', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, work: { x: 0, y: 0, width: 1920, height: 1032 }, scale: 1.25, primary: true }
const second = { device: '\\\\.\\DISPLAY2', bounds: { x: -1280, y: 0, width: 1280, height: 1024 }, work: { x: -1280, y: 0, width: 1280, height: 984 }, scale: 1, primary: false }
const browser = { hwnd: '0x10', pid: 400, process: 'chrome', title: 'Pixels - Google Chrome', className: 'Chrome_WidgetWin_1', bounds: { x: 100, y: 50, width: 1000, height: 800 }, monitor, elevated: false, url: 'https://example.com/pixels' }
const left = { hwnd: '0x20', pid: 500, process: 'notepad', title: 'Notes', className: 'Notepad', bounds: { x: -1200, y: 40, width: 600, height: 400 }, monitor: second, elevated: false }
const nodes = [
  { id: 'n1', role: 'button', name: 'Create pixel', bounds: { x: 200, y: 300, width: 120, height: 40 }, enabled: true, offscreen: false, path: 'Pixels' },
  { id: 'n2', role: 'textbox', name: 'Pixel name', value: 'Winter', bounds: { x: 200, y: 360, width: 300, height: 40 }, enabled: true, offscreen: false, path: 'Pixels > New pixel' },
  { id: 'n3', role: 'textbox', name: 'Secret key', bounds: { x: 200, y: 420, width: 300, height: 40 }, enabled: true, offscreen: false, path: 'Pixels > New pixel' },
  { id: '', role: 'button', name: 'Broken', bounds: null },
]
// A 1x1 PNG.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let watches = 0
let hooks = false
note({ type: 'start', args: process.argv.slice(2), pid: process.pid })
say({ event: 'ready', version: '0.0.0-fake', pid: process.pid, elevated: false })

createInterface({ input: process.stdin })
  .on('line', (line) => {
    let req
    try {
      req = JSON.parse(line)
    } catch {
      return
    }
    note({ type: 'request', ...req })
    const { id, op } = req
    if (op === 'quit') {
      note({ type: 'stop', how: 'quit', hooks })
      process.exit(0)
    }
    if (op === 'hello') return ok(id, { version: '0.0.0-fake', pid: process.pid, elevated: false, idleMs: 4200, hooks })
    if (op === 'exclude') return ok(id, true)
    if (op === 'activeWindow') return ok(id, browser)
    if (op === 'window') return ok(id, req.hwnd === '0x20' ? left : req.hwnd === '0x10' ? browser : null)
    if (op === 'windows') return ok(id, [browser, left, { hwnd: '', bounds: null }])
    if (op === 'monitors') return ok(id, [monitor, second])
    if (op === 'tree') {
      if (req.hwnd === '0x99') return fail(id, 'elevated', 'That window runs as administrator, so its controls cannot be read.')
      return ok(id, { seen: 40, nodes: nodes.slice(0, req.max) })
    }
    if (op === 'find') {
      if (req.name === 'HANG') return undefined
      if (req.name === 'CRASH') return process.exit(3)
      if (req.name === 'GARBAGE') return process.stdout.write('this is not json\n{"id":' + id + ',"ok":true,"ms":1,"result":{"node":null,"matches":0}}\n')
      const hit = nodes.find((n) => n.name.toLowerCase() === String(req.name).toLowerCase() && (req.role === undefined || n.role === req.role))
      return ok(id, { node: hit ?? null, matches: hit ? 1 : 0, road: 1 })
    }
    if (op === 'watch') {
      const watch = ++watches
      ok(id, { watch })
      const base = nodes.find((n) => n.id === req.node)?.bounds ?? { x: 0, y: 0, width: 10, height: 10 }
      setTimeout(() => say({ event: 'move', watch, rect: base, why: 'moved', time: Date.now() }), 10)
      setTimeout(() => say({ event: 'move', watch, rect: { ...base, y: base.y - 50 }, why: 'moved', time: Date.now() }), 40)
      setTimeout(() => say({ event: 'move', watch, rect: null, why: 'hidden', time: Date.now() }), 70)
      return undefined
    }
    if (op === 'unwatch') return ok(id, true)
    if (op === 'capture') return ok(id, { width: req.width ?? 1, height: req.height ?? 1, how: req.hwnd ? 'window' : 'screen', png })
    if (op === 'input') {
      hooks = req.on === true
      ok(id, { hooks })
      if (hooks) {
        setTimeout(() => {
          if (!hooks) return
          say({ event: 'input', kind: 'click', x: 260, y: 320, button: 'left', injected: false, time: Date.now() })
          say({ event: 'input', kind: 'wheel', x: 300, y: 400, time: Date.now() })
          say({ event: 'input', kind: 'key', key: 'Escape', ctrl: false, alt: false, shift: true, time: Date.now() })
          say({ event: 'input', kind: 'paste', time: Date.now() })
          say({ event: 'input', kind: 'foreground', window: left, time: Date.now() })
          say({ event: 'input', kind: 'click', x: 1, y: 1, button: 'thumb', time: Date.now() })
          say({ event: 'input', kind: 'typed', text: 'never', time: Date.now() })
        }, 20)
      }
      return undefined
    }
    return fail(id, 'unknown', `Unknown request: ${op}`)
  })
  .on('close', () => {
    note({ type: 'stop', how: 'stdin closed', hooks })
    process.exit(0)
  })
