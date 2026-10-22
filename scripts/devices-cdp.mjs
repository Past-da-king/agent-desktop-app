// Drives a running Electron or Chrome page over the DevTools protocol, with no dependency (Node's own WebSocket).
// Used for the Devices live proof on a test copy of the app started with --remote-debugging-port.
//   node scripts/devices-cdp.mjs settings <port> <outDir>   Settings > Devices: switch on, screenshot, Add a device, screenshot, save the code
//   node scripts/devices-cdp.mjs shoot <port> <outDir> <name> <width> <height> [mobile] [url]
import fs from 'node:fs'
import path from 'node:path'

const [mode, port, outDir, ...rest] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://') && !/quick|pill/i.test(t.url)) ?? targets[0]
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let next = 1
  const pending = new Map()
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = next++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
    return result.result.value
  }
  const shot = async (name, clip) => {
    const result = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
    fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(result.data, 'base64'))
  }
  return { send, evaluate, shot, close: () => ws.close(), url: page.url }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cdp = await connect()
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
// A window behind others gives no frames, and a screenshot would wait for ever.
await cdp.send('Page.bringToFront')

if (mode === 'settings') {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false })
  await cdp.evaluate(`location.hash = '#/settings'`)
  await sleep(1500)
  const before = await cdp.evaluate(`document.querySelector('[role=switch][aria-label="Let my other devices connect"]')?.getAttribute('aria-checked')`)
  if (before !== 'true') await cdp.evaluate(`document.querySelector('[role=switch][aria-label="Let my other devices connect"]').click()`)
  await sleep(2000)
  await cdp.evaluate(`document.querySelector('section.dv').scrollIntoView({ block: 'start' })`)
  await sleep(500)
  await cdp.shot('live-settings-devices-1280')
  const status = await cdp.evaluate(`document.querySelector('section.dv')?.innerText`)
  fs.writeFileSync(path.join(outDir, 'live-settings-devices.txt'), status ?? '')
  await cdp.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add a device').click()`)
  await sleep(1500)
  await cdp.shot('live-add-device-1280')
  const code = await cdp.evaluate(`document.querySelector('.dv-code')?.textContent ?? ''`)
  const rect = await cdp.evaluate(`(() => { const r = document.querySelector('.dv-qr-wrap').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  await cdp.shot('live-qr', rect)
  fs.writeFileSync(path.join(outDir, 'live-code.txt'), code)
  console.log(JSON.stringify({ code, switchWas: before }))
} else if (mode === 'phone') {
  // The same app at phone width (the renderer's own responsive layout), Settings > Devices.
  const [width = '390', height = '844'] = rest
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: Number(width), height: Number(height), deviceScaleFactor: 1, mobile: true })
  await cdp.evaluate(`document.querySelector('.scrim') && document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await sleep(600)
  await cdp.evaluate(`location.hash = '#/settings'`)
  await sleep(1200)
  await cdp.evaluate(`document.querySelector('section.dv').scrollIntoView({ block: 'start' })`)
  await sleep(500)
  await cdp.shot(`live-settings-devices-${width}`)
  await cdp.send('Emulation.clearDeviceMetricsOverride')
} else if (mode === 'revoke') {
  // Takes out the device named in rest[0] (its nth row, rest[1], default 1) through the real confirm dialog.
  const [name, nth = '1'] = rest
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false })
  await cdp.evaluate(`document.querySelector('.scrim') && document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await cdp.evaluate(`location.hash = '#/settings'`)
  await sleep(1200)
  const clicked = await cdp.evaluate(`(() => { const rows = [...document.querySelectorAll('.dv-row')].filter((r) => r.querySelector('.rt b')?.textContent === ${JSON.stringify(name)}); const row = rows[${Number(nth) - 1}]; if (!row) return false; row.scrollIntoView({ block: 'center' }); [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Take out').click(); return true })()`)
  await sleep(700)
  await cdp.shot(`live-revoke-confirm-${nth}`)
  await cdp.evaluate(`[...document.querySelectorAll('.dialog button')].find((b) => b.textContent.trim() === 'Take it out').click()`)
  await sleep(1500)
  await cdp.evaluate(`document.querySelector('section.dv').scrollIntoView({ block: 'start' })`)
  await sleep(400)
  await cdp.shot(`live-after-revoke-${nth}`)
  console.log(JSON.stringify({ clicked, list: await cdp.evaluate(`document.querySelector('section.dv').innerText`) }))
} else if (mode === 'section') {
  // Settings > Devices as it is now, at desktop and phone width (no clicks).
  for (const [width, height, mobile] of [[1280, 860, false], [390, 844, true]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
    await cdp.evaluate(`location.hash = '#/settings'`)
    await sleep(2500)
    await cdp.evaluate(`document.querySelector('section.dv').scrollIntoView({ block: 'start' })`)
    await sleep(600)
    await cdp.shot(`${rest[0] ?? 'live-devices'}-${width}`)
  }
  console.log(await cdp.evaluate(`document.querySelector('section.dv')?.innerText`))
  await cdp.send('Emulation.clearDeviceMetricsOverride')
} else if (mode === 'shoot') {
  const [name, width, height, mobile, url] = rest
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: Number(width), height: Number(height), deviceScaleFactor: 1, mobile: mobile === 'mobile' })
  if (url) {
    await cdp.send('Page.navigate', { url })
    await sleep(3000)
  }
  await cdp.shot(name)
}
cdp.close()
