// A local page with a cross-origin, nested iframe editor, for the input regression proofs.
// outer (localhost:A) > mid (127.0.0.1:B) > inner (127.0.0.2:C). Three different sites, so Chromium can put each in its
// own process. The inner page logs every pointer, mouse, key and input event (with isTrusted) back to the outer origin.
import { createServer } from 'node:http'

export const LAYOUT = {
  mid: { left: 50, top: 50, width: 600, height: 420 },
  inner: { left: 40, top: 40, width: 500, height: 320 },
  button: { left: 20, top: 20, width: 160, height: 40 },
  field: { left: 20, top: 80, width: 300, height: 30 },
  editable: { left: 20, top: 130, width: 300, height: 60 },
}
// The point of each control in the TOP page's coordinates.
const origin = { x: LAYOUT.mid.left + LAYOUT.inner.left, y: LAYOUT.mid.top + LAYOUT.inner.top }
export const POINTS = {
  button: { x: origin.x + LAYOUT.button.left + LAYOUT.button.width / 2, y: origin.y + LAYOUT.button.top + LAYOUT.button.height / 2 },
  field: { x: origin.x + LAYOUT.field.left + LAYOUT.field.width / 2, y: origin.y + LAYOUT.field.top + LAYOUT.field.height / 2 },
  editable: { x: origin.x + LAYOUT.editable.left + LAYOUT.editable.width / 2, y: origin.y + LAYOUT.editable.top + LAYOUT.editable.height / 2 },
}

export function startOrigins(ports = [0, 0, 0]) {
  const log = []
  const servers = []
  const bound = []
  const hosts = ['localhost', '127.0.0.1', '127.0.0.2']
  const url = (i, path) => `http://${hosts[i]}:${bound[i]}${path}`
  const html = (body) => `<!doctype html><meta charset=utf-8><body style="margin:0;font:14px sans-serif">${body}`
  const handler = (i) => (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const q = new URL(req.url ?? '/', 'http://x').searchParams
    if (path === '/log') {
      if (q.has('e')) {
        log.push({ e: q.get('e'), d: q.get('d') ?? '', t: q.get('t') ?? '' })
        res.writeHead(204).end()
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify(log))
      }
      return
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (path === '/') {
      res.end(html(`<p id=top style="position:absolute;left:100px;top:5px;margin:0">Cross-origin editor input test page. The editor below lives two iframes deep, on two other sites.</p><iframe id=mid src="${url(1, '/mid')}" style="position:absolute;left:${LAYOUT.mid.left}px;top:${LAYOUT.mid.top}px;width:${LAYOUT.mid.width}px;height:${LAYOUT.mid.height}px;border:0"></iframe>`))
    } else if (path === '/mid') {
      res.end(html(`<iframe id=inner src="${url(2, '/inner')}" style="position:absolute;left:${LAYOUT.inner.left}px;top:${LAYOUT.inner.top}px;width:${LAYOUT.inner.width}px;height:${LAYOUT.inner.height}px;border:0"></iframe>`))
    } else if (path === '/inner') {
      const L = LAYOUT
      const box = (c) => `position:absolute;left:${c.left}px;top:${c.top}px;width:${c.width}px;height:${c.height}px;box-sizing:border-box`
      res.end(html(`<button id=b style="${box(L.button)}">Design</button><input id=t aria-label="Slide title" style="${box(L.field)}"><div id=ce contenteditable=true role=textbox aria-label="Editor" style="${box(L.editable)};border:1px solid #888"></div>
<script>
const send = (e, d) => { new Image().src = 'http://localhost:${bound[0]}/log?e=' + encodeURIComponent(e) + '&d=' + encodeURIComponent(d || '') + '&t=' + Date.now() };
for (const type of ['pointerdown','pointerup','mousedown','mouseup','click','keydown','keyup','input','focusin']) {
  addEventListener(type, (ev) => send(type, (ev.target && ev.target.id || '') + '|' + (ev.isTrusted ? 'trusted' : 'synthetic') + '|' + (ev.key || ev.data || ev.pointerType || '')), true)
}
</script>`))
    } else res.writeHead(404).end()
  }
  return Promise.all(
    hosts.map(
      (host, i) =>
        new Promise((resolve) => {
          const s = createServer(handler(i))
          servers.push(s)
          s.listen(ports[i] ?? 0, host === 'localhost' ? '127.0.0.1' : host, () => {
            bound[i] = s.address().port
            resolve()
          })
        }),
    ),
  ).then(() => ({ log, outer: url(0, '/'), ports: bound, close: () => servers.forEach((s) => s.close()) }))
}

if (process.argv[1] && process.argv[1].endsWith('iframe-origins.mjs')) {
  const ports = (process.env.PORTS ?? '4201,4202,4203').split(',').map(Number)
  startOrigins(ports).then((s) => console.log('outer', s.outer, JSON.stringify(POINTS)))
}
