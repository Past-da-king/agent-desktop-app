/** A model request in flight ends the moment its signal aborts (a message from the person must be read now). */
import { createServer } from 'node:http'

import { describe, expect, it } from 'vitest'

import { providerFor, userMsg } from '../src'

describe('provider requests can be cut off', () => {
  it('an OpenAI-compatible request that never answers is aborted within a moment of the signal', async () => {
    let closed = false
    const server = createServer((req) => {
      req.on('close', () => {
        closed = true
      })
      // Never answers.
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    try {
      const provider = providerFor({ provider: 'openai', key: 'k', baseUrl: `http://127.0.0.1:${port}/v1`, allowHttp: true })
      const controller = new AbortController()
      const started = Date.now()
      setTimeout(() => controller.abort(), 150)
      await expect(provider.complete('system', [userMsg('hi')], [], 'm', 100, controller.signal)).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(1500)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(closed).toBe(true)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
