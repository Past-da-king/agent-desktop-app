import { createHash } from 'node:crypto'
import type { Tool } from '@agent/core'
import { getDevicesService } from '../devices/service'
import { outboundTarget } from './outbound-targets'

const GUARDED = new Set(['browser_fetch', 'apps_run', 'webapp_run', 'webapp_test'])
type ClaimAnswer = { state?: string; result?: string }
type Authority = { outboundCall(method: 'outbound.claim' | 'outbound.report', args: unknown[]): Promise<unknown> }

const HELD_UNKNOWN = 'Send held: an earlier try of this exact message may have gone out and its outcome is unknown. Check the channel or mailbox before sending it again; do not resend blindly.'
const HELD_BUSY = 'Send held: the same message is being sent right now by another agent. Do not resend.'
const HELD_UNREACHABLE = 'Send held: the send authority (the server) could not be reached, so this message was not sent. Try again in a moment.'

/** The claim key: the person's request, who acts, where it goes and what it says. Tokens never reach it in clear. */
export function outboundKey(requestId: string, profile: string, target: string, content: unknown): string {
  return createHash('sha256').update(JSON.stringify([requestId, profile, target, content])).digest('hex')
}

/**
 * Every message or file to a person is claimed at the one authority before it runs, so two brains (or a retry) that
 * run the same send post it once. The authority is a server node; a desktop asks it over the device link and holds
 * the send when it cannot get an answer from a verified server. Nothing here sends unguarded.
 */
export function withOutboundClaims(tools: Tool[], authority: () => Authority | null = getDevicesService): Tool[] {
  return tools.map((tool) => !GUARDED.has(tool.spec.name) ? tool : ({
    spec: tool.spec,
    run: async (input, ctx) => {
      const target = outboundTarget(tool.spec.name, input)
      // A tool run for another device's agent was claimed there, by the brain whose turn it is: one claim per send.
      if (target === null || ctx.owner === 'device') return tool.run(input, ctx)
      if (!ctx.requestId) return 'Send held: this run has no request from the person to tie the message to, so it was not sent.'
      const service = authority()
      if (service === null) return HELD_UNREACHABLE
      const key = outboundKey(ctx.requestId, ctx.profile ?? '', target.target, target.content)
      const claimOf = async (): Promise<ClaimAnswer | null> => {
        try { return await service.outboundCall('outbound.claim', [key]) as ClaimAnswer } catch { return null }
      }
      let claim = await claimOf()
      // Another brain holds it: wait for its outcome, so this one answers with the same receipt.
      for (let i = 0; claim?.state === 'in_progress' && i < 100; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        claim = await claimOf()
      }
      if (claim === null) return HELD_UNREACHABLE
      if (claim.state === 'sent') return 'already_sent: ' + String(claim.result ?? '')
      if (claim.state === 'in_progress') return HELD_BUSY
      if (claim.state !== 'granted') return HELD_UNKNOWN
      let result: string
      try {
        result = await tool.run(input, ctx)
      } catch (error) {
        await service.outboundCall('outbound.report', [key, { state: 'unknown' }]).catch(() => undefined)
        throw error
      }
      await service.outboundCall('outbound.report', [key, target.outcome(result)]).catch(() => undefined)
      return result
    },
  }))
}
