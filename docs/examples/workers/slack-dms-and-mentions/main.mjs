// Slack worker: the state of every conversation that involves one person, live over Socket Mode, caught up from a cursor.
// Contract: docs/workers-and-triggers.md. Built-ins only (fetch, WebSocket). Keys: SLACK_APP_TOKEN (xapp-, connections:write)
// and SLACK_USER_TOKEN (xoxp-, im/mpim/channels/groups history and read, users:read).
//
// It does not emit single messages. For a DM, a group DM, or a thread the person is in or mentioned in, it reads the
// whole conversation and emits its STATE: open (someone is waiting on them, who and since when) or closed (they
// answered, when and what they said). Their own messages are part of it, so a reply in a thread closes the ask.
// dedupeKey = conversation + its latest message, so a conversation that moves on is looked at again and one they
// answered stops coming back.
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const log = (text, level = 'info') => out({ type: 'log', level, text })
const APP = process.env.SLACK_APP_TOKEN || ''
const USER = process.env.SLACK_USER_TOKEN || ''
const TEST = process.env.AGENT_WORKER_TEST === '1'
const TZ = process.env.WORKER_TIMEZONE || 'Africa/Johannesburg'
const DM_WINDOW = 40 // top-level DM messages read for a DM's state
const RECENT = 6 // messages of context in each event

if (!APP.startsWith('xapp-') || !USER.startsWith('xoxp-')) {
  console.error('Missing keys: set SLACK_APP_TOKEN (xapp-) and SLACK_USER_TOKEN (xoxp-) on the Workers page.')
  process.exit(2)
}

let stopping = false
let catching = false
let newest = 0
process.stdin.on('data', (d) => {
  if (String(d).includes('"stop"')) {
    stopping = true
    process.exit(0)
  }
})

// The cursor is the newest message timestamp looked at (Slack ts, seconds with a fraction).
const downSince = Number(process.env.AGENT_WORKER_DOWN_SINCE || '0')
let cursor = Number(process.env.AGENT_WORKER_CURSOR || '0') || (downSince > 0 ? downSince / 1000 : Date.now() / 1000 - 3600)

async function api(method, params = {}, token = USER) {
  const body = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))
  for (let attempt = 0; attempt < 5; attempt++) {
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

let me = { id: '', team: '', teamName: '', domain: '' }
const names = new Map()
const channelInfo = new Map()
async function nameOf(user) {
  if (!user) return 'someone'
  if (user === me.id) return 'you'
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
    info = { kind: c.is_im ? 'dm' : c.is_mpim ? 'group' : c.is_private ? 'private-channel' : 'channel', name: c.name || (c.is_im ? await nameOf(c.user) : id) }
  } catch {}
  channelInfo.set(id, info)
  return info
}

async function readable(text) {
  let s = String(text || '')
  const users = [...new Set([...s.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]))]
  for (const u of users) s = s.split(new RegExp(`<@${u}(?:\\|[^>]*)?>`)).join(`@${await nameOf(u)}`)
  s = s.replace(/<#[CG][A-Z0-9]+\|([^>]+)>/g, '#$1')
  s = s.replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)').replace(/<(https?:[^>]+)>/g, '$1')
  return s
}

const when = (ts) => {
  const d = new Date(Number(ts) * 1000)
  const day = d.toLocaleDateString('en-ZA', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })
  const time = d.toLocaleTimeString('en-ZA', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day} ${time}`
}
const isNoise = (m) => !m || !m.ts || ['message_changed', 'message_deleted', 'channel_join', 'channel_leave', 'thread_broadcast'].includes(m.subtype)
// Bots and Slack's own notices never wait on anyone.
const fromBot = (m) => Boolean(m.bot_id) || m.subtype === 'bot_message' || m.user === 'USLACKBOT' || !m.user
const mentionsMe = (m) => typeof m.text === 'string' && m.text.includes(`<@${me.id}>`)
const linkTo = (channel, ts, root) =>
  `https://${me.domain}.slack.com/archives/${channel}/p${String(ts).replace('.', '')}${root && root !== ts ? `?thread_ts=${root}&cid=${channel}` : ''}`

/** The messages of one conversation, oldest first: a thread, or a DM's recent top-level messages. */
async function conversation(channel, threadTs) {
  if (threadTs) {
    const r = await api('conversations.replies', { channel, ts: threadTs, limit: 200 })
    return { root: threadTs, messages: (r.messages || []).filter((m) => !isNoise(m)) }
  }
  const r = await api('conversations.history', { channel, limit: DM_WINDOW })
  // Top level only; a message that has a thread is followed into it separately.
  return { root: '', messages: (r.messages || []).filter((m) => !isNoise(m) && (!m.thread_ts || m.thread_ts === m.ts)).reverse() }
}

const emitted = new Map() // conversation key -> latest ts already emitted (in this process)

/**
 * Look at one conversation and emit its state. Called for any new message in it, theirs or the person's own.
 * Skips conversations that do not involve the person and ones where nobody else has said anything.
 */
async function evaluate(channel, threadTs, reason) {
  const info = await channelOf(channel)
  const direct = info.kind === 'dm' || info.kind === 'group'
  const { root, messages } = await conversation(channel, threadTs)
  if (messages.length === 0) return false
  // A channel thread counts only if the person is in it or named in it.
  if (!direct && !messages.some((m) => m.user === me.id || mentionsMe(m))) return false
  const others = messages.filter((m) => m.user !== me.id && !fromBot(m))
  if (others.length === 0) return false
  const latest = messages[messages.length - 1]
  const key = `${me.team}/${channel}/${root || 'dm'}`
  if (emitted.get(key) === latest.ts) return false

  let myLast = [...messages].reverse().find((m) => m.user === me.id)
  // A mention in a channel is often answered in the channel itself, not in a thread under it: his next top-level
  // message in that channel after the ask counts as his reply.
  if (!direct && root) {
    const later = await api('conversations.history', { channel, oldest: root, limit: 100 }).catch(() => null)
    const mine = (later?.messages || []).filter((m) => m.user === me.id && Number(m.ts) > Number(root) && !isNoise(m))
    const top = mine.sort((a, b) => Number(b.ts) - Number(a.ts))[0]
    if (top && (!myLast || Number(top.ts) > Number(myLast.ts))) myLast = top
  }
  const after = (myLast ? messages.filter((m) => Number(m.ts) > Number(myLast.ts)) : messages).filter((m) => m.user !== me.id && !fromBot(m))
  const open = after.length > 0
  // What was asked: the waiting messages when open; when closed, what the reply answered.
  const asked = open ? after : messages.filter((m) => m.user !== me.id && !fromBot(m) && Number(m.ts) < Number(myLast.ts)).slice(-2)
  const kind = direct ? (info.kind === 'dm' ? 'dm' : 'group') : 'mention'
  const recent = []
  for (const m of messages.slice(-RECENT)) recent.push({ from: await nameOf(m.user), at: when(m.ts), text: (await readable(m.text)).slice(0, 600) })
  const waitingFrom = [...new Set(await Promise.all(after.map((m) => nameOf(m.user))))]
  const payload = {
    workspace: me.teamName,
    status: open ? 'open' : 'closed',
    summary: open
      ? `${waitingFrom.join(', ')} waiting on you since ${when(after[0].ts)}${myLast ? ` (your last reply was ${when(myLast.ts)})` : ''}`
      : `You replied ${when(myLast.ts)}; nothing new from them since`,
    channel: info.kind === 'dm' ? `DM with ${info.name}` : info.kind === 'group' ? 'group DM' : `#${info.name}`,
    thread: root ? 'yes' : 'no',
    waitingFrom: open ? waitingFrom : [],
    waitingSince: open ? when(after[0].ts) : null,
    asked: await Promise.all(asked.map(async (m) => ({ from: await nameOf(m.user), at: when(m.ts), text: (await readable(m.text)).slice(0, 2000) }))),
    yourReply: myLast ? { at: when(myLast.ts), text: (await readable(myLast.text)).slice(0, 2000) } : null,
    recent,
    link: linkTo(channel, (open ? after[0] : myLast).ts, root),
    reason,
  }
  out({
    type: 'event',
    source: 'slack',
    event: `${kind}.${open ? 'open' : 'closed'}`,
    dedupeKey: `${key}/${latest.ts}`,
    seenAt: Math.round(Number(latest.ts) * 1000),
    payload,
  })
  emitted.set(key, latest.ts)
  return true
}

function advance(ts) {
  const t = Number(ts)
  if (catching) {
    if (t > newest) newest = t
  } else if (t > cursor) {
    cursor = t
    out({ type: 'cursor', value: String(cursor) })
  }
}

/** A new message, from anyone: work out which conversation it belongs to and look at that conversation. */
async function onMessage(m, channel) {
  if (isNoise(m)) return false
  const info = await channelOf(channel)
  const direct = info.kind === 'dm' || info.kind === 'group'
  const inThread = m.thread_ts && m.thread_ts !== m.ts
  let done = false
  if (inThread) {
    done = await evaluate(channel, m.thread_ts, m.user === me.id ? 'you replied in the thread' : 'new reply in the thread')
  } else if (direct) {
    done = await evaluate(channel, '', m.user === me.id ? 'you wrote in the DM' : 'new DM')
    if (m.reply_count > 0) done = (await evaluate(channel, m.ts, 'thread under a DM')) || done
  } else if (mentionsMe(m) || (m.reply_count > 0 && m.reply_users?.includes(me.id))) {
    done = await evaluate(channel, m.ts, mentionsMe(m) ? 'you were mentioned' : 'thread you are in')
  }
  advance(m.latest_reply && Number(m.latest_reply) > Number(m.ts) ? m.latest_reply : m.ts)
  return done
}

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

async function pages(method, params, field = 'channels') {
  const all = []
  let next = ''
  do {
    const r = await api(method, { ...params, limit: 200, ...(next ? { cursor: next } : {}) })
    all.push(...(r[field] || []))
    next = r.response_metadata?.next_cursor || ''
  } while (next)
  return all
}

async function readSince(since) {
  let found = 0
  const convs = await pages('conversations.list', { types: 'im,mpim', exclude_archived: true })
  const chans = await pages('users.conversations', { types: 'public_channel,private_channel', exclude_archived: true })
  for (const c of [...convs, ...chans]) {
    const direct = c.is_im || c.is_mpim
    const r = await api('conversations.history', { channel: c.id, oldest: since, limit: 100 }).catch(() => null)
    const msgs = (r?.messages || []).slice().reverse()
    if (direct && msgs.some((m) => !isNoise(m) && (!m.thread_ts || m.thread_ts === m.ts))) {
      if (await evaluate(c.id, '', 'catch-up')) found++
    }
    for (const m of msgs) {
      advance(m.ts)
      // Threads that started (or got replies) since the cursor and involve the person.
      if (m.reply_count > 0 && (direct || mentionsMe(m) || m.reply_users?.includes(me.id))) {
        if (await evaluate(c.id, m.ts, 'catch-up')) found++
      } else if (!direct && mentionsMe(m)) {
        if (await evaluate(c.id, m.ts, 'catch-up')) found++
      }
    }
  }
  log(`Caught up from ${new Date(since * 1000).toISOString()}: ${found} conversation${found === 1 ? '' : 's'} (${convs.length} DMs, ${chans.length} channels looked at).`)
}

async function live() {
  const open = await api('apps.connections.open', {}, APP)
  const ws = new WebSocket(open.url)
  let alive = Date.now()
  // Messages in one conversation are handled one at a time, in order.
  let chain = Promise.resolve()
  ws.addEventListener('message', (msg) => {
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
      if (e && e.type === 'message') chain = chain.then(() => onMessage(e, e.channel)).catch((err) => log(String(err.message || err), 'warn'))
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
