#!/usr/bin/env node
/**
 * A scripted OpenAI-compatible server for self-testing scripts/devices-e2e.mjs against real local nodes without a real
 * AI. Plain Node, no dependencies. Listens on 127.0.0.1 only.
 *
 *   node scripts/devices-e2e-fake-ai.mjs [--port 18080]      then give nodes the base URL http://127.0.0.1:<port>/v1
 *
 * It reads the newest user message of each request and answers like an agent would for the harness checks:
 *  - "Reply with exactly this code ... <code>"         -> the code
 *  - "use the open_url tool to open <url> ..."          -> calls open_url, then device_tool notify, then "done"
 *  - "start a chat in the "<project>" project ..."      -> calls project_chat_start, then "started"
 *  - "... end with this code on its own line: <code>"  -> waits 20 s (a turn long enough to kill), then answers
 *  - a resume note ("was interrupted")                  -> answers the code of the interrupted request once
 *  - anything else                                       -> "ok"
 */
import { createServer } from 'node:http'

const portFlag = process.argv.indexOf('--port')
const port = portFlag > 0 ? Number(process.argv[portFlag + 1]) : 18080
const SLOW_MS = Number(process.env.FAKE_AI_SLOW_MS ?? 20_000)

function textOf(message) {
  if (typeof message?.content === 'string') return message.content
  if (Array.isArray(message?.content)) return message.content.map((part) => part?.text ?? '').join(' ')
  return ''
}

function reply(res, message) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id: `fake-${Date.now()}`, object: 'chat.completion', model: 'fake', choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
}

const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: `call_${Math.random().toString(36).slice(2)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const say = (content) => ({ role: 'assistant', content })

createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      // empty
    }
    if (!String(req.url).endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'fake-model', object: 'model' }] }))
      return
    }
    const messages = Array.isArray(body.messages) ? body.messages : []
    const lastUserIndex = messages.map((m) => m.role).lastIndexOf('user')
    const user = textOf(messages[lastUserIndex])
    const after = messages.slice(lastUserIndex + 1)
    const toolsUsed = after.filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)).flatMap((m) => m.tool_calls.map((t) => t.function?.name))
    const all = messages.map(textOf).join('\n')

    if (/was interrupted/.test(user)) {
      const code = [...all.matchAll(/end with this code on its own line: (e2e-[a-z]-[0-9a-f]+)/g)].at(-1)?.[1]
      return reply(res, say(code ? `Picked up after the interruption.\n${code}` : 'Carried on.'))
    }
    const exact = /Reply with exactly this code and nothing else: (\S+)/.exec(user)
    if (exact) return reply(res, say(exact[1]))
    const open = /use the open_url tool to open (\S+) on my device.*title "([^"]+)"/.exec(user)
    if (open) {
      if (!toolsUsed.includes('open_url')) return reply(res, call('open_url', { url: open[1] }))
      if (!toolsUsed.includes('device_tool')) return reply(res, call('device_tool', { device: 'best', tool: 'notify', args: { title: open[2], body: 'test' } }))
      return reply(res, say('done'))
    }
    const project = /start a chat in the "([^"]+)" project \(use project_chat_start\) with the brief "([^"]+)"/.exec(user)
    if (project) {
      if (!toolsUsed.includes('project_chat_start')) return reply(res, call('project_chat_start', { project: project[1], brief: project[2] }))
      return reply(res, say('started'))
    }
    const slow = /end with this code on its own line: (\S+)/.exec(user)
    if (slow) {
      await new Promise((resolve) => setTimeout(resolve, SLOW_MS))
      if (res.destroyed) return
      return reply(res, say(`A short paragraph for the test.\n${slow[1]}`))
    }
    const brief = /^Reply with (e2e-\S+) and stop\.$/.exec(user.trim())
    if (brief) return reply(res, say(brief[1]))
    return reply(res, say('ok'))
  })
}).listen(port, '127.0.0.1', () => console.log(`fake AI on http://127.0.0.1:${port}/v1`))
