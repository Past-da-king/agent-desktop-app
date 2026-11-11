// usage: node cdp.mjs <port> <js expression>   (evaluates in the first "page" target whose url is the app)
const [port, ...rest] = process.argv.slice(2)
const expr = rest.join(' ')
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const pages = list.filter((t) => t.type === 'page')
const target = pages.find((t) => t.url.startsWith('file:') && !/#\/(dictation|quick)/.test(t.url)) ?? pages[0]
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id === 1) {
    console.log(JSON.stringify(d.result?.result?.value ?? d.result ?? d.error, null, 1))
    process.exit(0)
  }
}
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
setTimeout(() => process.exit(1), 15000)

