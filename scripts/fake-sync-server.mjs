// A small in-memory re-implementation of the sync service (reference/kotlin-sync-service/Main.kt) for tests.
// Same endpoints, JSON shapes and status codes. Not for production.
import http from 'node:http'
import crypto from 'node:crypto'

export async function startFakeSyncServer({ port = 0 } = {}) {
  const users = new Map() // email -> {id, salt, hash}
  const tokens = new Map() // token -> userId
  const logs = new Map() // userId -> [{seq, device, entity, id, deleted, stamp, payload}]
  const waiters = new Map() // userId -> Set<() => void>
  let nextUser = 1
  const stats = { requests: 0, pushes: 0, pulls: 0 }

  const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('base64')
  const send = (res, code, body) => {
    const text = JSON.stringify(body)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  }
  const err = (res, code, message) => send(res, code, { error: { message } })
  const readJson = (req) =>
    new Promise((resolve) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const s = Buffer.concat(chunks).toString('utf8')
        try { resolve(s ? JSON.parse(s) : {}) } catch { resolve({}) }
      })
    })
  const userFor = (req) => {
    const h = req.headers.authorization || ''
    if (!h.startsWith('Bearer')) return null
    return tokens.get(h.slice(6).trim()) ?? null
  }
  const newToken = (userId) => {
    const t = crypto.randomBytes(32).toString('base64url')
    tokens.set(t, userId)
    return t
  }
  const since = (userId, after, entity) => {
    const log = logs.get(userId) ?? []
    const changes = log.filter((c) => c.seq > after && (!entity || c.entity === entity))
    const cursor = log.length ? log[log.length - 1].seq : 0
    return { changes: changes.map(({ device, ...c }) => c), cursor }
  }

  const server = http.createServer(async (req, res) => {
    stats.requests++
    const url = new URL(req.url ?? '/', 'http://x')
    try {
      if (url.pathname === '/health') return send(res, 200, { ok: true })
      if (url.pathname === '/v1/auth/register' && req.method === 'POST') {
        const b = await readJson(req)
        const email = String(b.email ?? '').trim().toLowerCase()
        const password = String(b.password ?? '')
        if (!email || password.length < 6) return err(res, 400, 'email and a password of at least 6 characters are required')
        if (users.has(email)) return err(res, 409, 'an account with that email already exists')
        const salt = crypto.randomBytes(16).toString('base64')
        const id = nextUser++
        users.set(email, { id, salt, hash: hash(password, salt) })
        return send(res, 200, { userId: id, token: newToken(id) })
      }
      if (url.pathname === '/v1/auth/login' && req.method === 'POST') {
        const b = await readJson(req)
        const u = users.get(String(b.email ?? '').trim().toLowerCase())
        if (!u || hash(String(b.password ?? ''), u.salt) !== u.hash) return err(res, 401, 'email or password is not correct')
        return send(res, 200, { userId: u.id, token: newToken(u.id) })
      }
      if (url.pathname === '/v1/sync/push' && req.method === 'POST') {
        const userId = userFor(req)
        if (!userId) return err(res, 401, 'sign in first')
        stats.pushes++
        const b = await readJson(req)
        const log = logs.get(userId) ?? []
        logs.set(userId, log)
        for (const c of Array.isArray(b.changes) ? b.changes : []) {
          log.push({
            seq: (log.length ? log[log.length - 1].seq : 0) + 1,
            device: String(b.device ?? ''),
            entity: c.entity,
            id: c.id,
            deleted: !!c.deleted,
            stamp: c.stamp,
            payload: c.payload ?? {},
          })
        }
        for (const w of waiters.get(userId) ?? []) w()
        return send(res, 200, { cursor: log.length ? log[log.length - 1].seq : 0 })
      }
      if (url.pathname === '/v1/sync/pull' && req.method === 'GET') {
        const userId = userFor(req)
        if (!userId) return err(res, 401, 'sign in first')
        stats.pulls++
        const after = Number(url.searchParams.get('since') ?? 0) || 0
        const entity = url.searchParams.get('entity') || undefined
        const waitSec = Math.min(55, Math.max(0, Number(url.searchParams.get('wait') ?? 0) || 0))
        let result = since(userId, after, entity)
        if (result.changes.length === 0 && waitSec > 0) {
          await new Promise((resolve) => {
            const set = waiters.get(userId) ?? new Set()
            waiters.set(userId, set)
            const done = () => { clearTimeout(timer); set.delete(done); resolve() }
            const timer = setTimeout(done, waitSec * 1000)
            set.add(done)
            res.on('close', done)
          })
          result = since(userId, after, entity)
        }
        return send(res, 200, result)
      }
      return err(res, 404, 'no such endpoint')
    } catch (e) {
      return err(res, 500, e instanceof Error ? e.message : 'server error')
    }
  })

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const addr = server.address()
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}`
  return {
    url,
    stats,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startFakeSyncServer({ port: Number(process.env.PORT ?? 8790) })
  console.log(`fake sync server on ${s.url}`)
}
