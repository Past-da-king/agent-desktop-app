// A scripted device for the Devices live proof (no dependency): pairs with a node using the agent://pair URI from
// its QR code (certificate pinned by fingerprint), then uses the app over /v1/rpc and fetches a file.
//   node scripts/devices-client.mjs pair '<agent://pair?...>' <out.json> [base-url-override]
//   node scripts/devices-client.mjs use <out.json> [base-url-override]
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { request } from 'node:https'

const [mode, a, b, c] = process.argv.slice(2)

function parsePair(uri) {
  const query = uri.slice(uri.indexOf('?') + 1)
  const v = Object.fromEntries(query.split('&').map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]))
  return { meshId: decodeURIComponent(v.mesh), nodeId: decodeURIComponent(v.node), name: decodeURIComponent(v.name), urls: v.u.split(',').map(decodeURIComponent), fp: decodeURIComponent(v.fp), secret: decodeURIComponent(v.c) }
}

const pin = (fp) => (socket) => {
  socket.once('secureConnect', () => {
    const seen = createHash('sha256').update(socket.getPeerCertificate().raw).digest('base64url')
    if (seen !== fp) socket.destroy(new Error(`certificate ${seen} does not match the pinned ${fp}`))
  })
}

function https(url, fp, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const req = request(url, { method, agent: false, rejectUnauthorized: false, timeout: 4000, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (res) => {
      const chunks = []
      res.on('data', (x) => chunks.push(x))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('socket', pin(fp))
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    req.end(data)
  })
}

const PHONE = { name: 'Scripted phone', kind: 'phone', platform: 'android', appVersion: '0.0.1', screen: { width: 412, height: 915 }, canOpenLinks: true, canReceiveFiles: true, fingerprint: '', urls: [] }

function frame(opcode, payload) {
  const len = payload.length
  const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len]) : len < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(len), 2); return h })()
  const key = randomBytes(4)
  const body = Buffer.from(payload.map((x, i) => x ^ key[i % 4]))
  return Buffer.concat([head, key, body])
}

function rpc(base, fp, pass) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/v1/rpc`, { agent: false, rejectUnauthorized: false, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), Authorization: `Bearer ${pass}` } })
    req.on('socket', pin(fp))
    req.on('response', (res) => reject(new Error(`upgrade refused ${res.statusCode}`)))
    req.on('error', reject)
    req.on('upgrade', (_res, socket, head) => {
      let buf = head
      const pending = new Map()
      const events = []
      let next = 1
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        for (;;) {
          if (buf.length < 2) return
          let len = buf[1] & 127
          let off = 2
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
          if (buf.length < off + len) return
          const op = buf[0] & 15
          const payload = buf.subarray(off, off + len)
          buf = buf.subarray(off + len)
          if (op === 9) socket.write(frame(10, payload))
          if (op !== 1) continue
          const msg = JSON.parse(payload.toString())
          if (msg.type === 'result') { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.ok) p?.resolve(msg.value); else p?.reject(new Error(msg.error)) }
          if (msg.type === 'event') events.push(msg)
        }
      })
      socket.write(frame(1, Buffer.from(JSON.stringify({ type: 'hello', device: PHONE }))))
      resolve({
        events,
        call: (method, ...args) => new Promise((ok, fail) => { const id = String(next++); pending.set(id, { resolve: ok, reject: fail }); socket.write(frame(1, Buffer.from(JSON.stringify({ type: 'call', id, method, args })))) }),
        close: () => { socket.write(frame(8, Buffer.from([3, 232]))); socket.end() },
      })
    })
    req.end()
  })
}

async function firstReachable(urls, fp) {
  for (const url of urls) {
    try {
      const health = await https(`${url}/v1/health`, fp)
      if (health.status === 200) return url
      console.log(`  ${url}: HTTP ${health.status}`)
    } catch (error) {
      console.log(`  ${url}: ${error.message}`)
    }
  }
  return null
}

if (mode === 'pair') {
  const offer = parsePair(a)
  console.log(`offer from ${offer.name} (${offer.nodeId}), fp ${offer.fp}, ${offer.urls.length} address(es)`)
  const urls = c ? [c] : offer.urls
  const base = await firstReachable(urls, offer.fp)
  if (base === null) throw new Error('no address of the node answered')
  console.log(`reached ${base}`)
  const res = await https(`${base}/v1/pair`, offer.fp, { method: 'POST', body: { code: offer.secret, device: PHONE, wantRoles: ['screen'] } })
  const answer = JSON.parse(res.body.toString())
  console.log(`pair: HTTP ${res.status}, deviceId ${answer.deviceId}, brains ${JSON.stringify(answer.brains?.map((x) => x.name))}`)
  if (res.status !== 200) process.exit(1)
  fs.writeFileSync(b, JSON.stringify({ base, fp: offer.fp, ...answer }, null, 2))
} else if (mode === 'use') {
  const saved = JSON.parse(fs.readFileSync(a, 'utf8'))
  const base = b ?? saved.base
  const client = await rpc(base, saved.fp, saved.pass)
  const settings = await client.call('settings.get')
  console.log(`settings.get: deviceName "${settings.deviceName}", keys in reply: ${Object.keys(settings).length}`)
  try { await client.call('settings.setApiKey', 'x') } catch (e) { console.log(`settings.setApiKey refused: ${e.message}`) }
  const task = await client.call('data.upsert', 'task', { title: 'Made from the scripted phone', notes: '', status: 'todo', owner: 'user' })
  await new Promise((r) => setTimeout(r, 500))
  const heard = client.events.filter((e) => e.name === 'agent:evt:data.changed' && e.payload?.row?.id === task.id)
  console.log(`data.upsert task ${task.id}; heard its data.changed event: ${heard.length > 0}`)
  const tasks = await client.call('data.list', 'task')
  console.log(`data.list task: ${tasks.length} row(s)`)
  const state = await client.call('chat.state', '')
  console.log(`chat.state: running ${state.running}`)
  const devices = await https(`${base}/v1/devices`, saved.fp, { headers: { Authorization: `Bearer ${saved.pass}` } })
  console.log(`GET /v1/devices: HTTP ${devices.status}, ${JSON.parse(devices.body.toString()).devices.map((d) => `${d.name} [${d.roles}]`).join(', ')}`)
  const pasted = await client.call('files.savePasted', 'from-phone.txt', 'text/plain', { $b64: Buffer.from('hello from the phone').toString('base64') })
  console.log(`files.savePasted: ${pasted.path}`)
  const file = await https(`${base}/v1/file?path=${encodeURIComponent(pasted.path)}`, saved.fp, { headers: { Authorization: `Bearer ${saved.pass}` } })
  console.log(`GET /v1/file: HTTP ${file.status}, "${file.body.toString()}"`)
  const refused = await https(`${base}/v1/file?path=${encodeURIComponent('C:\\Windows\\win.ini')}`, saved.fp, { headers: { Authorization: `Bearer ${saved.pass}` } })
  console.log(`GET /v1/file outside the shared places: HTTP ${refused.status}`)
  await client.call('data.remove', 'task', task.id)
  client.close()
}
