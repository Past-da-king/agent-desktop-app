// node act.mjs <hwnd> '<json act args>' ['<json>' ...]   prints each result, checks cursor+foreground unchanged
import { open, sleep } from './sc.mjs'
const s = open()
const hwnd = process.argv[2]
for (const raw of process.argv.slice(3)) {
  const args = JSON.parse(raw)
  const op = args.op ?? 'act'; delete args.op
  const before = await s.call('presence')
  const t0 = Date.now()
  const r = await s.call(op, { hwnd, ...args })
  const after = await s.call('presence')
  const same = before.foreground === after.foreground
  if (r && r.png) r.png = `<${r.png.length} b64>`
  if (r && r.nodes) r.nodes = r.nodes.length + ' nodes'
  console.log(`${raw}\n  -> ${JSON.stringify(r)}\n  ${Date.now() - t0} ms; fg ${same ? 'same' : 'CHANGED ' + before.foreground + '->' + after.foreground}; cursor ${JSON.stringify(before.cursor)} -> ${JSON.stringify(after.cursor)}`)
}
s.close()
