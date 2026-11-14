/**
 * The real-Electron focus proof of the agent's own browser (11 Nov 2026, docs/agent-cursor.md "Browser focus"). Only index.ts
 * calls it, only when AGENT_FOCUS_PROBE names a spec file; never in normal use.
 *
 * It measures, in the app window's own page (the chat), whether the keyboard ever leaves the message box while the agent
 * drives its browser, and which tool moved it:
 *   - the app page: document.activeElement and the box's caret, every 10 ms, plus every focusin / focusout / window blur;
 *   - the main process: focus and blur of the window, of the app page and of every agent page;
 *   - a typist that types a known text into the message box with webContents.sendInputEvent (which follows in-window
 *     focus, so no operating system focus is needed and the window can stay off his screen);
 *   - a loop of the agent's browser tools (open, snapshot, look, read, eval, scroll, click, type, select, tick, press,
 *     upload, view), each tagged by name so a focus change is blamed on the tool that was running.
 * It writes one JSON file with the numbers and the events. It never calls a focus function itself.
 *
 * Spec: { out, seconds, text, cps, url, uploadFile?, onlyTool?, typist? }
 */
import { readFileSync, writeFileSync } from 'node:fs'

import type { BrowserWindow, WebContents } from 'electron'

import type { AgentBrowser } from './browser'

interface Spec {
  out: string
  seconds: number
  text: string
  cps: number
  url: string
  uploadFile?: string
  /** Run only this tool, over and over (to blame it). */
  onlyTool?: string
  /** false: no typist, only the sampling (the per-tool table). Default true. */
  typist?: boolean
  /** true: find the call that moves the keyboard: before every tool the box gets the keyboard back, and every call the browser makes is checked after it. */
  blame?: boolean
  /** true: the typist sends each key to whoever holds the keyboard (the page during a click of the agent), as the operating system does. */
  routeLikeOs?: boolean
  /** true: micro-experiments, one raw call each, judged 250 ms after it (so a late steal is not blamed on the next call). */
  exp?: boolean
}

const STATE_JS = `(() => { const b = document.querySelector('[data-composer]'); return document.hasFocus() && document.activeElement === b })()`
const REFOCUS_JS = `(() => { const b = document.querySelector('[data-composer]'); b.focus(); return document.hasFocus() && document.activeElement === b })()`

interface Ev {
  at: number
  who: string
  ev: string
  tool: string
  detail?: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const PAGE_INSTALL = `(() => {
  if (window.__fp) return true;
  const fp = { log: [], samples: 0, off: 0, noDocFocus: 0, caretJumps: 0, offTool: {}, tool: '', t0: Date.now() };
  window.__fp = fp;
  const box = () => document.querySelector('[data-composer]');
  const d = (e) => e ? (e.tagName + (e.id ? '#' + e.id : '') + (e.hasAttribute && e.hasAttribute('data-composer') ? '[composer]' : '')) : 'null';
  const push = (ev, el, rel) => { if (fp.log.length < 4000) fp.log.push({ at: Date.now(), who: 'page', ev, tool: fp.tool, detail: d(el) + (rel === undefined ? '' : ' -> ' + d(rel)) }); };
  document.addEventListener('focusin', (e) => push('focusin', e.target, e.relatedTarget), true);
  document.addEventListener('focusout', (e) => push('focusout', e.target, e.relatedTarget), true);
  window.addEventListener('blur', () => push('window.blur'));
  window.addEventListener('focus', () => push('window.focus'));
  setInterval(() => {
    const el = box();
    if (!el) return;
    fp.samples++;
    if (document.activeElement !== el) { fp.off++; fp.offTool[fp.tool] = (fp.offTool[fp.tool] || 0) + 1; }
    if (!document.hasFocus()) fp.noDocFocus++;
    if (el.selectionStart !== el.value.length || el.selectionEnd !== el.value.length) { fp.caretJumps++; }
  }, 10);
  return true;
})()`

export async function runFocusProbe(browser: AgentBrowser, main: WebContents, win: BrowserWindow, specPath: string): Promise<void> {
  const spec = JSON.parse(readFileSync(specPath, 'utf8').replace(/^\uFEFF/, '')) as Spec
  const events: Ev[] = []
  let tool = 'idle'
  const push = (who: string, ev: string, detail?: string): void => {
    if (events.length < 4000) events.push({ at: Date.now(), who, ev, tool, ...(detail === undefined ? {} : { detail }) })
  }
  const counts = { mainBlur: 0, winBlur: 0, guestFocus: 0, guestBlur: 0, mainFocus: 0 }
  main.on('blur', () => { counts.mainBlur++; push('mainWC', 'blur') })
  main.on('focus', () => { counts.mainFocus++; push('mainWC', 'focus') })
  win.on('blur', () => { counts.winBlur++; push('win', 'blur') })
  win.on('focus', () => push('win', 'focus'))
  const watched = new Set<number>()
  const watchGuests = (): void => {
    const wc = browser.tabWebContents()
    if (wc === null || wc.isDestroyed() || watched.has(wc.id)) return
    watched.add(wc.id)
    wc.on('focus', () => { counts.guestFocus++; push('guestWC' + wc.id, 'focus') })
    wc.on('blur', () => { counts.guestBlur++; push('guestWC' + wc.id, 'blur') })
  }

  // a chat with a message box: Home has none, so press New chat the way he would
  await main.executeJavaScript(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^New chat$/.test((x.innerText || '').trim())); if (b) b.click(); return !!b })()`).catch(() => false)
  // wait for the message box
  const t0 = Date.now()
  while (Date.now() - t0 < 120_000) {
    const there = await main.executeJavaScript(`!!document.querySelector('[data-composer]')`).catch(() => false)
    if (there === true) break
    await sleep(500)
  }
  await main.executeJavaScript(PAGE_INSTALL)
  console.log(`FOCUS PROBE open\n${await browser.probeOpen(spec.url)}`)
  watchGuests()
  // He is typing in the box: the box has the keyboard (done in the page, like a click of his).
  await main.executeJavaScript(`(() => { const b = document.querySelector('[data-composer]'); b.value = ''; b.focus(); return document.activeElement === b })()`, true)
  const setTool = async (name: string): Promise<void> => {
    tool = name
    await main.executeJavaScript(`window.__fp.tool = ${JSON.stringify(name)}`).catch(() => undefined)
  }
  await setTool('idle')
  await sleep(500)


  // blame mode: wrap every call the browser makes on its page and check the keyboard right after it
  const blamed: Record<string, Record<string, number>> = {}
  const wrapped = new Set<number>()
  const check = async (label: string): Promise<void> => {
    const ok = (await main.executeJavaScript(STATE_JS).catch(() => true)) === true
    if (ok) return
    const row = (blamed[tool] ??= {})
    row[label] = (row[label] ?? 0) + 1
    // give it back (proof only) so the next call is judged on its own
    main.focus()
    await main.executeJavaScript(REFOCUS_JS).catch(() => undefined)
  }
  const wrapGuest = (): void => {
    const wc = browser.tabWebContents()
    if (wc === null || wc.isDestroyed() || wrapped.has(wc.id)) return
    wrapped.add(wc.id)
    const dbg = wc.debugger as unknown as { sendCommand: (m: string, p?: unknown) => Promise<unknown> }
    const send = dbg.sendCommand.bind(dbg)
    dbg.sendCommand = async (m, p) => {
      try {
        return await send(m, p)
      } finally {
        if (/^(Input|Page|DOM|Emulation|Target|Runtime)\./.test(m)) await check(`cdp ${m}`)
      }
    }
    const w = wc as unknown as Record<string, (...a: unknown[]) => unknown>
    for (const name of ['executeJavaScript', 'executeJavaScriptInIsolatedWorld', 'capturePage', 'sendInputEvent', 'loadURL', 'focus', 'setZoomFactor']) {
      const orig = w[name]
      if (typeof orig !== 'function') continue
      w[name] = function (...a: unknown[]) {
        const r = orig.apply(wc, a)
        if (r !== null && typeof r === 'object' && typeof (r as Promise<unknown>).then === 'function') return (r as Promise<unknown>).finally(() => check(`wc.${name}`))
        void check(`wc.${name}`)
        return r
      }
    }
  }


  if (spec.exp === true) {
    const wc = browser.tabWebContents()
    if (wc === null) throw new Error('no tab')
    const dbg = wc.debugger
    await browser.act({ action: 'focus', name: 'Your name', role: 'textbox' }).catch(() => '')
    const settle = async (): Promise<boolean> => {
      main.focus()
      await main.executeJavaScript(REFOCUS_JS).catch(() => undefined)
      await sleep(300)
      return (await main.executeJavaScript(STATE_JS).catch(() => false)) === true
    }
    const rect = (await dbg.sendCommand('Runtime.evaluate', { expression: `(() => { const r = document.getElementById('name').getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: devicePixelRatio, w: innerWidth }) })()`, returnByValue: true })) as { result: { value: string } }
    const at = JSON.parse(rect.result.value) as { x: number; y: number }
    const x = Math.round(at.x), y = Math.round(at.y)
    const experiments: Array<[string, () => Promise<unknown>]> = [
      ['nothing (control)', async () => undefined],
      ['Runtime.evaluate el.focus()', () => dbg.sendCommand('Runtime.evaluate', { expression: `document.getElementById('name').focus()` })],
      ['isolated-world el.focus()', () => wc.executeJavaScriptInIsolatedWorld(999, [{ code: `document.getElementById('secret').focus()` }])],
      ['Runtime.evaluate el.blur()', () => dbg.sendCommand('Runtime.evaluate', { expression: `document.activeElement && document.activeElement.blur()` })],
      ['Input.insertText', () => dbg.sendCommand('Input.insertText', { text: 'x' })],
      ['Input.dispatchMouseEvent mouseMoved', () => dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })],
      ['Input.dispatchMouseEvent mouseWheel', () => dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 10 })],
      ['Input.dispatchKeyEvent Shift down/up', async () => { await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 }); await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 }) }],
      ['wc.sendInputEvent keyDown/keyUp Shift', async () => { wc.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' }) }],
      ['wc.sendInputEvent mouseMove', async () => { wc.sendInputEvent({ type: 'mouseMove', x, y }) }],
      ['Input.dispatchMouseEvent mousePressed+Released (body, no focusable)', async () => { await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 700, button: 'left', buttons: 1, clickCount: 1 }); await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 700, button: 'left', buttons: 0, clickCount: 1 }) }],
      ['Input.synthesizeTapGesture mouse (body, no focusable)', () => dbg.sendCommand('Input.synthesizeTapGesture', { x: 5, y: 700, duration: 40, tapCount: 1, gestureSourceType: 'mouse' })],
      ['Input.dispatchMouseEvent mousePressed+Released on the field', async () => { await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }); await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }) }],
      ['Input.synthesizeTapGesture mouse on the field', () => dbg.sendCommand('Input.synthesizeTapGesture', { x, y, duration: 40, tapCount: 1, gestureSourceType: 'mouse' })],
      ['Emulation.setFocusEmulationEnabled false then Input.insertText', async () => { await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false }); await dbg.sendCommand('Input.insertText', { text: 'y' }); await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }) }],
      ['Input.dispatchKeyEvent Enter', async () => { const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }; await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...k, text: '\r' }); await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...k }) }],
      ['Input.dispatchKeyEvent Space', async () => { const k = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }; await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...k, text: ' ' }); await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...k }) }],
      ['Input.dispatchKeyEvent Tab', async () => { const k = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }; await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k }); await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...k }) }],
      ['Input.dispatchKeyEvent ArrowDown', async () => { const k = { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }; await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k }); await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...k }) }],
      ['webview inert, then mousePressed+Released', async () => { await main.executeJavaScript(`document.querySelector('webview').inert = true`); await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 700, button: 'left', buttons: 1, clickCount: 1 }); await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 700, button: 'left', buttons: 0, clickCount: 1 }); }],
      ['webview hidden-visibility, then mousePressed+Released', async () => { await main.executeJavaScript(`(() => { const v = document.querySelector('webview'); v.inert = false; v.style.visibility = 'hidden' })()`); await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 700, button: 'left', buttons: 1, clickCount: 1 }); await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 700, button: 'left', buttons: 0, clickCount: 1 }); await main.executeJavaScript(`document.querySelector('webview').style.visibility = ''`) }],
      ['Input.dispatchTouchEvent tap', async () => { await dbg.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 5, y: 700 }] }); await dbg.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }) }],
      ['Page.captureScreenshot', () => dbg.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 30 })],
      ['wc.capturePage', () => wc.capturePage(undefined, { stayHidden: true })],
    ]
    const table: Array<{ experiment: string; keptKeyboard: boolean; errorMessage?: string }> = []
    for (const [name, run] of experiments) {
      const before = await settle()
      let err = ''
      try { await run() } catch (e) { err = e instanceof Error ? e.message : String(e) }
      await sleep(250)
      const kept = (await main.executeJavaScript(STATE_JS).catch(() => false)) === true
      table.push({ experiment: name + (before ? '' : ' [box was not focused before]'), keptKeyboard: kept, ...(err === '' ? {} : { errorMessage: err.slice(0, 80) }) })
    }
    // second set: does the text and the click REACH THE PAGE, and does the box keep the keyboard? (insertText and keys follow the focused widget of the whole window, so a quiet page that is not focused can be bypassed)
    const pageEval = async (expr: string): Promise<string> => {
      const r = (await dbg.sendCommand('Runtime.evaluate', { expression: expr, returnByValue: true })) as { result: { value: unknown } }
      return String(r.result.value)
    }
    const scaleOf = async (): Promise<number> => Number(await main.executeJavaScript(`(() => { const v = document.querySelector('webview'); return v.getBoundingClientRect().width })()`)) / Number(await pageEval('innerWidth'))
    const sc = await scaleOf()
    const reach: Array<{ experiment: string; landedInPage: boolean; composerGotIt: boolean; keptKeyboard: boolean; note?: string }> = []
    const trial = async (name: string, focusJs: string, readJs: string, act: () => Promise<unknown>, expectChange: (before: string, after: string) => boolean): Promise<void> => {
      main.focus()
      await main.executeJavaScript(`document.querySelector('[data-composer]').value = ''`)
      await main.executeJavaScript(REFOCUS_JS)
      await sleep(200)
      await pageEval(focusJs)
      await sleep(100)
      main.focus()
      await main.executeJavaScript(REFOCUS_JS)
      await sleep(150)
      const before = await pageEval(readJs)
      let err = ''
      try { await act() } catch (e) { err = e instanceof Error ? e.message : String(e) }
      await sleep(300)
      const after = await pageEval(readJs)
      const composer = String(await main.executeJavaScript(`document.querySelector('[data-composer]').value`))
      const kept = (await main.executeJavaScript(STATE_JS).catch(() => false)) === true
      reach.push({ experiment: name, landedInPage: expectChange(before, after), composerGotIt: composer.length > 0, keptKeyboard: kept, ...(err === '' ? {} : { note: err.slice(0, 80) }) })
    }
    const nameVal = `document.getElementById('name').value`
    const focusName = `document.getElementById('name').focus()`
    await trial('Input.insertText q (reference)', focusName, nameVal, () => dbg.sendCommand('Input.insertText', { text: 'q' }), (b, a) => a !== b)
    await trial('wc.insertText q', focusName, nameVal, async () => wc.insertText('q'), (b, a) => a !== b)
    await trial('wc.sendInputEvent keyDown+char+keyUp q', focusName, nameVal, async () => { wc.sendInputEvent({ type: 'keyDown', keyCode: 'q' }); wc.sendInputEvent({ type: 'char', keyCode: 'q' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'q' }) }, (b, a) => a !== b)
    await trial('Input.dispatchKeyEvent char q (reference)', focusName, nameVal, async () => { await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q', code: 'KeyQ', text: 'q', windowsVirtualKeyCode: 81 }); await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81 }) }, (b, a) => a !== b)
    const agreeRect = JSON.parse(await pageEval(`(() => { const r = document.getElementById('agree').getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()`)) as { x: number; y: number }
    const cx = Math.round(agreeRect.x * sc), cy = Math.round(agreeRect.y * sc)
    const checked = `document.getElementById('agree').checked`
    await trial(`wc.sendInputEvent mouseDown+mouseUp on the tick box (scale ${sc.toFixed(3)})`, `document.getElementById('agree').checked = false`, checked, async () => { wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 }) }, (b, a) => a !== b)
    await trial(`Input.dispatchMouseEvent press+release on the tick box (reference)`, `document.getElementById('agree').checked = false`, checked, async () => { await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 }); await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1 }) }, (b, a) => a !== b)
    await trial('Space key on the focused tick box (Input.dispatchKeyEvent)', `(() => { const a = document.getElementById('agree'); a.checked = false; a.focus() })()`, checked, async () => { await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32 }); await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }) }, (b, a) => a !== b)
    await trial('Space key on the focused tick box (wc.sendInputEvent)', `(() => { const a = document.getElementById('agree'); a.checked = false; a.focus() })()`, checked, async () => { wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); wc.sendInputEvent({ type: 'char', keyCode: ' ' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' }) }, (b, a) => a !== b)
    writeFileSync(spec.out, JSON.stringify({ done: true, table, reach }, null, 1))
    console.log('FOCUS PROBE done')
    return
  }

  // the typist
  let typed = 0
  const typingOn = spec.typist !== false && spec.blame !== true
  // Like the operating system, a key goes to whoever holds the keyboard in the window: the page while a click of the agent holds it, else the chat.
  let toPage = 0
  const char = (ch: string): void => {
    const guest = browser.tabWebContents()
    const held = spec.routeLikeOs === true && browser.keyboardHeldByPage() && guest !== null && !guest.isDestroyed()
    const target = held && guest !== null ? guest : main
    if (held) toPage++
    const code = ch === ' ' ? 'Space' : ch
    target.sendInputEvent({ type: 'keyDown', keyCode: code })
    target.sendInputEvent({ type: 'char', keyCode: ch })
    target.sendInputEvent({ type: 'keyUp', keyCode: code })
  }
  let typistTimer: NodeJS.Timeout | null = null
  const started = Date.now()
  if (typingOn) {
    typistTimer = setInterval(() => {
      if (typed >= spec.text.length || main.isDestroyed()) return
      char(spec.text[typed] as string)
      typed++
    }, Math.round(1000 / spec.cps))
  }

  const tools: Array<[string, () => Promise<unknown>]> = [
    ['open', () => browser.probeOpen(spec.url)],
    ['snapshot', () => browser.snapshotPro({ deep: true })],
    ['snapshot_plain', () => browser.snapshot()],
    ['look', () => browser.screenshot()],
    ['read', () => browser.read({})],
    ['eval', () => browser.evaluate(`document.title + ' ' + document.querySelectorAll('input').length`, 5)],
    ['scroll', () => browser.scroll(200)],
    ['act_click_field', () => browser.act({ action: 'click', name: 'Your name', role: 'textbox' })],
    ['act_type_text', () => browser.act({ action: 'type', name: 'Your name', role: 'textbox', text: 'Thandi Nkosi' })],
    ['act_type_password', () => browser.act({ action: 'type', name: 'Secret', role: 'textbox', text: 'hunter2hunter2' })],
    ['act_select', () => browser.act({ action: 'select', name: 'Colour', text: 'Green' })],
    ['act_check', () => browser.act({ action: 'check', name: 'I agree' })],
    ['act_focus', () => browser.act({ action: 'focus', name: 'Your name', role: 'textbox' })],
    ['act_press', () => browser.act({ action: 'press', key: 'Tab' })],
    ['act_hover', () => browser.act({ action: 'hover', name: 'Send' })],
    ['act_scroll', () => browser.act({ action: 'scroll', dy: 120 })],
    ['act_click_button', () => browser.act({ action: 'click', name: 'Send', role: 'button' })],
    ['click_index', () => browser.click(1)],
    ['type_index', () => browser.type(2, 'index typed', false)],
    ['press', () => browser.press('Tab')],
    ['view', () => browser.view({ mode: 'desktop' })],
    ...(spec.uploadFile === undefined ? [] : [['upload', () => browser.upload({ name: 'Attach' } as never, [spec.uploadFile as string])] as [string, () => Promise<unknown>]]),
  ]
  const loop = spec.onlyTool === undefined ? tools : tools.filter(([name]) => name === spec.onlyTool)
  const results: Array<{ tool: string; at: number; answer: string }> = []
  let round = 0
  while (Date.now() - started < spec.seconds * 1000) {
    for (const [name, run] of loop) {
      if (Date.now() - started >= spec.seconds * 1000) break
      if (spec.blame === true) {
        wrapGuest()
        main.focus()
        await main.executeJavaScript(REFOCUS_JS).catch(() => undefined)
        await sleep(80)
      }
      await setTool(name)
      let answer = ''
      try {
        const value = await run()
        answer = typeof value === 'string' ? value : value === null || value === undefined ? String(value) : '[object]'
      } catch (error) {
        answer = `THREW ${error instanceof Error ? error.message : String(error)}`
      }
      watchGuests()
      if (spec.blame === true) await check(`tool ${name} returned`)
      if (round < 2) results.push({ tool: name, at: Date.now() - started, answer: answer.slice(0, 160) })
      await setTool('between')
      await sleep(250)
    }
    round++
  }
  await setTool('tail')
  // let the typist finish its text
  while (typingOn && typed < spec.text.length && Date.now() - started < spec.seconds * 1000 + 90_000) await sleep(200)
  await sleep(600)
  if (typistTimer !== null) clearInterval(typistTimer)
  const page = (await main.executeJavaScript(`(() => { const b = document.querySelector('[data-composer]'); return { fp: window.__fp, value: b ? b.value : null, active: document.activeElement ? document.activeElement.tagName : null } })()`)) as {
    fp: Record<string, unknown>
    value: string | null
    active: string | null
  }
  const text = spec.text
  const got = page.value ?? ''
  // lost = source characters missing from the box, extra = characters in the box that are not in the source (edit distance)
  const n = text.length
  const m = got.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let a = 0; a <= n; a++) dp[a]![0] = a
  for (let b = 0; b <= m; b++) dp[0]![b] = b
  for (let a = 1; a <= n; a++) for (let b = 1; b <= m; b++) dp[a]![b] = Math.min(dp[a - 1]![b]! + 1, dp[a]![b - 1]! + 1, dp[a - 1]![b - 1]! + (text[a - 1] === got[b - 1] ? 0 : 1))
  const distance = dp[n]![m]!
  writeFileSync(
    spec.out,
    JSON.stringify(
      {
        done: true,
        seconds: spec.seconds,
        typed,
        sourceLength: text.length,
        composerLength: got.length,
        exact: got === text,
        editDistance: distance,
        lostChars: Math.max(0, n - m),
        sentToPageAndReplayed: toPage,
        guard: browser.keyboardGivenBack(),
        counts,
        samples: page.fp['samples'],
        samplesOffComposer: page.fp['off'],
        samplesNoDocFocus: page.fp['noDocFocus'],
        caretJumps: page.fp['caretJumps'],
        offByTool: page.fp['offTool'],
        blamed,
        results,
        events,
        pageEvents: page.fp['log'],
        composerValue: got.slice(0, 600),
      },
      null,
      1,
    ),
  )
  console.log('FOCUS PROBE done')
}
