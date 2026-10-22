// Slack worker: direct messages and mentions for one person, live over Socket Mode, caught up from a cursor.
// Contract: docs/workers-and-triggers.md. Built-ins only (fetch, WebSocket). Keys: SLACK_APP_TOKEN (xapp-, connections:write)
// and SLACK_USER_TOKEN (xoxp-, im/mpim/channels/groups history and read, users:read).
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const log = (text, level = 'info') => out({ type: 'log', level, text })
const APP = process.env.SLACK_APP_TOKEN || ''
const USER = process.env.SLACK_USER_TOKEN || ''
const TEST = process.env.AGENT_WORKER_TEST === '1'

if (!APP.startsWith('xapp-') || !USER.startsWith('xoxp-')) {
  console.error('Missing keys: set SLACK_APP_TOKEN (xapp-) and SLACK_USER_TOKEN (xoxp-) on the Workers page.')
  process.exit(2)
}

let stopping = false
// While catching up, conversations are read one by one in no particular time order, so the checkpoint is only
// written once all of them are done; a crash halfway re-reads them (repeats are deduped by the app).
let catching = false
let newest = 0
process.stdin.on('data', (d) => {
  if (String(d).includes('"stop"')) {
    stopping = true
    process.exit(0)
  }
})

// The cursor is the newest message timestamp emitted (Slack ts, seconds with a fraction).
const downSince = Number(process.env.AGENT_WORKER_DOWN_SINCE || '0')
let cursor = Number(process.env.AGENT_WORKER_CURSOR || '0') || (downSince > 0 ? downSince / 1000 : Date.now() / 1000 - 3600)

async function api(method, params = {}, token = USER) {
  const body = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://slack.com/api/${method}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body })
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || '2')
      await new Promise((r) => setTimeout(r, wait * 1000))
      continue
    }
    const json = await res.json()
    if (!json.ok) throw new Error(`${method}: ${json.error}`)
    return json
  }
  throw new Error(`${method}: rate limited`)
}

let me = { id: '', team: '' }
const names = new Map()
const channelInfo = new Map()
async function nameOf(user) {
  if (!user) return ''
  if (names.has(user)) return names.get(user)
  try {
    const r = await api('users.info', { user })
    const n = r.user?.profile?.display_name || r.user?.real_name || r.user?.name || user
    names.set(user, n)
    return n
  } catch {
    return user
  }
}
async function channelOf(id) {
  if (channelInfo.has(id)) return channelInfo.get(id)
  let info = { kind: id.startsWith('D') ? 'dm' : 'channel', name: id }
  try {
    const r = await api('conversations.info', { channel: id })
    const c = r.channel || {}
    info = { kind: c.is_im ? 'dm' : c.is_mpim ? 'group-dm' : c.is_private ? 'private-channel' : 'channel', name: c.name || (c.is_im ? await nameOf(c.user) : id) }
  } catch {}
  channelInfo.set(id, info)
  return info
}

// Slack's markup into words: <@U123> -> @Name, <#C1|general> -> #general, <https://x|label> -> label (https://x).
async function readable(text) {
  let out = String(text || '')
  const users = [...new Set([...out.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]))]
  for (const u of users) out = out.split(new RegExp(`<@${u}(?:\\|[^>]*)?>`)).join(`@${u === me.id ? 'you' : await nameOf(u)}`)
  out = out.replace(/<#[CG][A-Z0-9]+\|([^>]+)>/g, '#$1')
  out = out.replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)').replace(/<(https?:[^>]+)>/g, '$1')
  return out
}

// Only what matters to the person: a DM or group DM to them, or a mention of them; never their own messages.
async function emitIfMine(m, channel) {
  if (!m || !m.ts || m.subtype === 'message_changed' || m.subtype === 'message_deleted' || m.subtype === 'bot_message' && !m.text) return false
  if (m.user === me.id) return false
  const info = await channelOf(channel)
  const mention = typeof m.text === 'string' && m.text.includes(`<@${me.id}>`)
  const direct = info.kind === 'dm' || info.kind === 'group-dm'
  if (!direct && !mention) return false
  const ts = Number(m.ts)
  out({
    type: 'event',
    source: 'slack',
    event: direct ? (info.kind === 'dm' ? 'message.dm' : 'message.group') : 'message.mention',
    dedupeKey: `${me.team}/${channel}/${m.ts}`,
    seenAt: Math.round(ts * 1000),
    payload: {
      workspace: me.teamName,
      from: await nameOf(m.user),
      channel: info.kind === 'dm' ? 'DM' : info.name,
      text: (await readable(m.text)).slice(0, 4000),
      thread: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : undefined,
      link: `https://${me.domain}.slack.com/archives/${channel}/p${String(m.ts).replace('.', '')}`,
    },
  })
  if (catching) {
    if (ts > newest) newest = ts
  } else if (ts > cursor) {
    cursor = ts
    out({ type: 'cursor', value: String(cursor) })
  }
  return true
}

// Catch up: every DM and group DM with something newer than the cursor, plus mentions via search when allowed.
async function catchUp() {
  const since = cursor
  catching = true
  newest = 0
  try {
    await readSince(since)
  } finally {
    catching = false
  }
  if (newest > cursor) {
    cursor = newest
    out({ type: 'cursor', value: String(cursor) })
  }
}

async function readSince(since) {
  let found = 0
  let next = ''
  const convs = []
  do {
    const r = await api('conversations.list', { types: 'im,mpim', limit: 200, exclude_archived: true, ...(next ? { cursor: next } : {}) })
    convs.push(...(r.channels || []))
    next = r.response_metadata?.next_cursor || ''
  } while (next)
  for (const c of convs) {
    const r = await api('conversations.history', { channel: c.id, oldest: since, limit: 100 }).catch(() => null)
    const msgs = (r?.messages || []).slice().reverse()
    for (const m of msgs) if (await emitIfMine(m, c.id)) found++
  }
  // Mentions in channels: the channels the person is in, newest messages only.
  let chNext = ''
  const chans = []
  do {
    const r = await api('users.conversations', { types: 'public_channel,private_channel', limit: 200, exclude_archived: true, ...(chNext ? { cursor: chNext } : {}) })
    chans.push(...(r.channels || []))
    chNext = r.response_metadata?.next_cursor || ''
  } while (chNext)
  for (const c of chans) {
    const r = await api('conversations.history', { channel: c.id, oldest: since, limit: 100 }).catch(() => null)
    for (const m of (r?.messages || []).slice().reverse()) if (await emitIfMine(m, c.id)) found++
  }
  log(`Caught up from ${new Date(since * 1000).toISOString()}: ${found} message${found === 1 ? '' : 's'} (${convs.length} DMs, ${chans.length} channels looked at).`)
}

async function live() {
  const open = await api('apps.connections.open', {}, APP)
  const ws = new WebSocket(open.url)
  let alive = Date.now()
  ws.addEventListener('message', async (msg) => {
    alive = Date.now()
    let env
    try {
      env = JSON.parse(String(msg.data))
    } catch {
      return
    }
    if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }))
    if (env.type === 'hello') {
      out({ type: 'ready' })
      log('Connected to Slack (Socket Mode).')
    } else if (env.type === 'disconnect') {
      log(`Slack asked to reconnect (${env.reason || 'no reason'}).`)
      ws.close()
    } else if (env.type === 'events_api') {
      const e = env.payload?.event
      if (e && e.type === 'message') await emitIfMine(e, e.channel).catch((err) => log(String(err.message || err), 'warn'))
    }
  })
  await new Promise((resolve) => {
    ws.addEventListener('close', resolve)
    ws.addEventListener('error', (e) => {
      log(`Socket error: ${e.message || 'unknown'}`, 'warn')
      resolve()
    })
    const beat = setInterval(() => {
      out({ type: 'alive' })
      if (Date.now() - alive > 5 * 60_000) {
        log('No word from Slack for 5 minutes; reconnecting.', 'warn')
        ws.close()
      }
    }, 30_000)
    ws.addEventListener('close', () => clearInterval(beat))
  })
}

async function main() {
  const who = await api('auth.test')
  me = { id: who.user_id, team: who.team_id, teamName: who.team, domain: new URL(who.url).hostname.split('.')[0] }
  log(`Signed in as ${who.user} in ${who.team}. Cursor ${new Date(cursor * 1000).toISOString()}.`)
  await catchUp()
  if (TEST) {
    log('Test run: caught up, not staying connected.')
    return
  }
  // Slack closes sockets now and then; open a fresh one each time, catching up on any gap in between.
  for (;;) {
    await live()
    if (stopping) return
    await new Promise((r) => setTimeout(r, 2000))
    await catchUp().catch((err) => log(`Catch-up failed: ${err.message}`, 'warn'))
  }
}

main().catch((err) => {
  console.error(err.message || String(err))
  process.exit(1)
})
