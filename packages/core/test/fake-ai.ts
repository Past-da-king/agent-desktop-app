/**
 * A local HTTP server that speaks both the Anthropic Messages shape (`POST /v1/messages`) and the
 * OpenAI Chat Completions shape (`POST /v1/chat/completions`), returning a scripted reply.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { asObject, type JsonObject } from '../src/model'

export interface FakeToolCall {
  name: string
  input: JsonObject
}

export interface FakeReply {
  text?: string
  toolCalls?: FakeToolCall[]
  reasoning?: string
  /** Respond with this HTTP status instead of 200. `text` becomes the error message. */
  status?: number
}

export interface RecordedRequest {
  path: string
  headers: Record<string, string>
  body: JsonObject
}

export interface FakeAi {
  /** Base URL to give a provider, e.g. http://127.0.0.1:45231/v1 */
  url: string
  requests: RecordedRequest[]
  close(): Promise<void>
}

export async function startFakeAi(
  script: (requestBody: JsonObject, callIndex: number) => FakeReply,
): Promise<FakeAi> {
  const requests: RecordedRequest[] = []

  const server = createServer((req, res) => {
    void handle(req, res)
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const text = await readBody(req)
    let body: JsonObject = {}
    try {
      body = asObject(JSON.parse(text) as unknown)
    } catch {
      body = {}
    }
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : (value ?? '')
    }
    requests.push({ path, headers, body })
    const index = requests.length - 1
    const reply = script(body, index)

    if (reply.status !== undefined && reply.status >= 400) {
      send(res, reply.status, { error: { message: reply.text ?? 'fake error' } })
      return
    }
    if (path === '/v1/messages') {
      send(res, 200, anthropicReply(reply, index))
      return
    }
    if (path === '/v1/chat/completions') {
      send(res, 200, openAiReply(reply, index))
      return
    }
    send(res, 404, { error: { message: `no route for ${path}` } })
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('fake AI server did not bind to a port')
  }

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

function anthropicReply(reply: FakeReply, index: number): JsonObject {
  const content: JsonObject[] = []
  for (const call of reply.toolCalls ?? []) {
    content.push({ type: 'tool_use', id: `tool_${index}_${content.length}`, name: call.name, input: call.input })
  }
  if (reply.text !== undefined) content.push({ type: 'text', text: reply.text })
  return {
    id: `msg_${index}`,
    type: 'message',
    role: 'assistant',
    content,
    stop_reason: (reply.toolCalls ?? []).length > 0 ? 'tool_use' : 'end_turn',
    usage: { input_tokens: 12, output_tokens: 5 },
  }
}

function openAiReply(reply: FakeReply, index: number): JsonObject {
  const message: JsonObject = {
    role: 'assistant',
    content: reply.text ?? null,
  }
  if (reply.reasoning !== undefined) message.reasoning_content = reply.reasoning
  if ((reply.toolCalls ?? []).length > 0) {
    message.tool_calls = (reply.toolCalls ?? []).map((call, i) => ({
      id: `call_${index}_${i}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.input) },
    }))
  }
  return {
    id: `chatcmpl_${index}`,
    object: 'chat.completion',
    model: 'fake-model',
    choices: [
      {
        index: 0,
        message,
        finish_reason: (reply.toolCalls ?? []).length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 5 },
  }
}

function send(res: ServerResponse, status: number, payload: JsonObject): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}
