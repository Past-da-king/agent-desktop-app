import { createHash } from 'node:crypto'
import type { Tool } from '@agent/core'
import { getDevicesService } from '../devices/service'

/** Claim a Slack post before executing it on the device that owns its credentials. */
export function withOutboundClaims(tools: Tool[]): Tool[] {
  return tools.map(tool => tool.spec.name !== 'browser_fetch' ? tool : {
    spec: tool.spec,
    run: async (input, ctx) => {
      const url = typeof input['url'] === 'string' ? input['url'] : ''
      if (!/^https:\/\/slack\.com\/api\/chat\.postMessage(?:\?|$)/i.test(url) || String(input['method'] ?? 'GET').toUpperCase() !== 'POST') return tool.run(input, ctx)
      if (!ctx.requestId) return 'Send held: no request identity.'
      const service = getDevicesService()
      if (!service) return 'Send held: authority unreachable.'
      const key = createHash('sha256').update(JSON.stringify([ctx.requestId, url, input['body'] ?? ''])).digest('hex')
      let claim: { state?: string }
      try { claim = await service.outboundCall('outbound.claim', [key]) as { state?: string } } catch { return 'Send held: authority unreachable.' }
      for (let i = 0; claim.state === 'in_progress' && i < 50; i++) {
        await new Promise(resolve => setTimeout(resolve, 100))
        try { claim = await service.outboundCall('outbound.claim', [key]) as { state?: string; result?: string } } catch { return 'Send held: authority unreachable.' }
      }
      if (claim.state !== 'granted') return claim.state === 'sent' ? 'already_sent: ' + String((claim as { result?: string }).result ?? '') : 'Send held: already in progress or outcome unknown.'
      try {
        const result = await tool.run(input, ctx)
        let receipt: string | undefined
        const body = result.match(/\nBody(?: \([^\n]*\))?:\n([^\n]+)/)?.[1]
        try {
          const parsed = JSON.parse(body ?? '') as { ok?: unknown; ts?: unknown }
          if (parsed.ok === true && typeof parsed.ts === 'string' && /^\d+\.\d+$/.test(parsed.ts)) receipt = parsed.ts
        } catch { /* keep unknown when the provider response is not conclusive */ }
        await service.outboundCall('outbound.report', [key, receipt ? { state: 'sent', result: receipt } : { state: 'unknown' }]).catch(() => undefined)
        return result
      } catch (error) {
        await service.outboundCall('outbound.report', [key, { state: 'unknown' }]).catch(() => undefined)
        throw error
      }
    },
  })
}
