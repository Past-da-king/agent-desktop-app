/**
 * The agent's own tools, offered to an AI tool the person already has installed (Claude Code first) over
 * the Model Context Protocol. This is how a subscription drives the agent on this computer: the CLI does
 * the thinking on the person's plan, and every action still goes through the app's tools, so question
 * cards, approvals, memory and the granted-folder rules all apply exactly as with an API key.
 *
 * Deliberately small: MCP "Streamable HTTP" with plain JSON responses (no SSE), bound to 127.0.0.1 on a
 * random port, and every request must carry a random bearer token that only the spawned CLI knows.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { JsonObject, Tool, ToolContext } from '@agent/core'

export interface ToolServer {
  url: string
  /** A new key for one run: requests carrying it see that run's tools and context. */
  open(run: ToolRun): string
  /** Forget a run's key; its requests are refused from then on. */
  release(token: string): void
  close(): Promise<void>
}

/** One run's view of the app: several runs (the main agent and its helpers) use the server at once. */
export interface ToolRun {
  tools: Tool[]
  context: ToolContext
  /** Called around each tool call, so the chat shows it as it happens. */
  onCall?: (call: { id: string; name: string; input: JsonObject }) => void | Promise<void>
  onResult?: (call: { id: string; name: string; input: JsonObject }, result: string, isError: boolean) => void | Promise<void>
}

const PROTOCOL = '2025-03-26'
const MAX_BODY = 4 * 1024 * 1024

interface RpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

let callSeq = 0

export async function startToolServer(): Promise<ToolServer> {
  const runs = new Map<string, ToolRun>()
  const find = (given: string): ToolRun | undefined => {
    for (const [token, run] of runs) if (same(given, token)) return run
    return undefined
  }

  const handle = async (rpc: RpcRequest, run: ToolRun): Promise<unknown> => {
    switch (rpc.method) {
      case 'initialize':
        return {
          protocolVersion: typeof rpc.params?.['protocolVersion'] === 'string' ? rpc.params['protocolVersion'] : PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agent', version: '1' },
        }
      case 'ping':
        return {}
      case 'tools/list':
        return {
          tools: run.tools.map((tool) => ({
            name: tool.spec.name,
            description: tool.spec.description,
            inputSchema: tool.spec.schema,
          })),
        }
      case 'tools/call': {
        const name = String(rpc.params?.['name'] ?? '')
        const raw = rpc.params?.['arguments']
        const input: JsonObject = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as JsonObject) : {}
        const tool = run.tools.find((item) => item.spec.name === name)
        const call = { id: `mcp-${(callSeq += 1)}`, name, input }
        if (tool === undefined) return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true }
        await run.onCall?.(call)
        let text: string
        let isError = false
        try {
          text = await tool.run(input, run.context)
        } catch (error) {
          text = `Error: ${error instanceof Error ? error.message : String(error)}`
          isError = true
        }
        if (text.length > 24_000) text = `${text.slice(0, 24_000)}\n...(cut, ${text.length} chars total)`
        await run.onResult?.(call, text, isError)
        return { content: [{ type: 'text', text }], isError }
      }
      default:
        throw Object.assign(new Error(`Method not found: ${rpc.method}`), { code: -32601 })
    }
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const run = find(bearer(req))
      if (run === undefined) return send(res, 401, { error: 'unauthorised' })
      if (req.method === 'GET') return send(res, 405, { error: 'no event stream' })
      if (req.method === 'DELETE') return send(res, 200, {})
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      let parsed: unknown
      try {
        parsed = JSON.parse(await readBody(req))
      } catch {
        return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      }
      const batch = Array.isArray(parsed) ? (parsed as RpcRequest[]) : [parsed as RpcRequest]
      const replies: unknown[] = []
      for (const rpc of batch) {
        if (rpc.id === undefined || rpc.id === null) continue // a notification: nothing to answer
        try {
          replies.push({ jsonrpc: '2.0', id: rpc.id, result: await handle(rpc, run) })
        } catch (error) {
          const code = (error as { code?: number }).code ?? -32603
          replies.push({ jsonrpc: '2.0', id: rpc.id, error: { code, message: error instanceof Error ? error.message : 'error' } })
        }
      }
      if (replies.length === 0) {
        res.writeHead(202)
        res.end()
        return
      }
      send(res, 200, Array.isArray(parsed) ? replies : replies[0])
    })()
  })
  // Approval cards can wait for the person for a long time; never time a tool call out on our side.
  server.requestTimeout = 0
  server.headersTimeout = 0
  server.keepAliveTimeout = 60_000

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    open: (run) => {
      const token = randomBytes(32).toString('base64url')
      runs.set(token, run)
      return token
    },
    release: (token) => {
      runs.delete(token)
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
