/**
 * Electron main for browser-touch-guest.test.ts. A <webview> guest with a cross-origin iframe, on an Electron whose
 * engine is told it has a touchscreen (--touch-events=enabled). For each case it applies the app's own touch profile
 * (the bundled touch-profile.ts) and prints what the page and the iframe report as one JSON line per case.
 * Env: TOUCH_PROFILE_BUNDLE (the bundle), CASES (comma list: off, desktop, phone).
 */
const { app, BrowserWindow } = require('electron')
const http = require('node:http')

app.commandLine.appendSwitch('touch-events', 'enabled')
app.commandLine.appendSwitch('disable-gpu')
const { TouchProfileHost } = require(process.env.TOUCH_PROFILE_BUNDLE)

const PROBE = `JSON.stringify({
  maxTouchPoints: navigator.maxTouchPoints,
  ontouchstart: 'ontouchstart' in window,
  pointerCoarse: matchMedia('(pointer: coarse)').matches,
  pointerFine: matchMedia('(pointer: fine)').matches,
  anyPointerFine: matchMedia('(any-pointer: fine)').matches,
  hoverHover: matchMedia('(hover: hover)').matches,
  anyHoverHover: matchMedia('(any-hover: hover)').matches,
})`

const html = (body) => (_q, r) => {
  r.setHeader('content-type', 'text/html')
  r.end(body)
}
const inner = http.createServer(html('<body>inner</body>'))
let outerPort = 0
const outer = http.createServer((q, r) => {
  r.setHeader('content-type', 'text/html')
  if (q.url === '/host') return r.end('<body></body>')
  // The inner frame is another site (localhost, not 127.0.0.1): a frame in its own process.
  r.end(`<body>outer<iframe src="http://localhost:${inner.address().port}/"></iframe></body>`)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

process.on('uncaughtException', (e) => {
  console.log('FAIL ' + e.message)
  app.exit(1)
})
setTimeout(() => {
  console.log('FAIL timeout')
  app.exit(2)
}, 90000)

app.whenReady().then(async () => {
  await new Promise((r) => inner.listen(0, '127.0.0.1', r))
  await new Promise((r) => outer.listen(0, '127.0.0.1', r))
  outerPort = outer.address().port
  for (const name of (process.env.CASES || 'off,desktop,phone').split(',')) {
    const host = new BrowserWindow({ show: true, width: 900, height: 700, webPreferences: { webviewTag: true } })
    await host.loadURL(`http://127.0.0.1:${outerPort}/host`)
    const guestReady = new Promise((r) => host.webContents.once('did-attach-webview', (_e, wc) => r(wc)))
    await host.webContents.executeJavaScript(`(() => { const w = document.createElement('webview'); w.setAttribute('src', 'about:blank'); w.style.cssText = 'width:800px;height:600px'; document.body.appendChild(w); })()`)
    const wc = await guestReady
    await sleep(500)
    await wc.loadURL('about:blank')
    wc.debugger.attach('1.3')
    const link = {
      send: (m, p, s) => (s ? wc.debugger.sendCommand(m, p, s) : wc.debugger.sendCommand(m, p)),
      onEvent: (l) => {
        const h = (_e, m, p, s) => l(m, p, s || undefined)
        wc.debugger.on('message', h)
        return () => wc.debugger.removeListener('message', h)
      },
    }
    await wc.debugger.sendCommand('Page.enable')
    const touchHost = new TouchProfileHost(link)
    if (name === 'phone') {
      await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
      await touchHost.apply('touch')
    } else {
      await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 })
      if (name === 'desktop') await touchHost.apply('desktop')
    }
    await wc.loadURL(`http://127.0.0.1:${outerPort}/`)
    await sleep(2500)
    const top = JSON.parse(await wc.executeJavaScript(PROBE))
    const frames = wc.mainFrame.framesInSubtree.filter((f) => f !== wc.mainFrame)
    const result = { case: name, top, frames: frames.length, frame: frames.length ? JSON.parse(await frames[0].executeJavaScript(PROBE)) : null }
    console.log('RESULT ' + JSON.stringify(result))
    host.destroy()
  }
  app.exit(0)
})
