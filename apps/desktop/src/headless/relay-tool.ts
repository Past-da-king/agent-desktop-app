/**
 * web_fetch_via_device: the headless node fetches a page through one of the person's own paired computers (its
 * relay.fetch, main/devices/relay.ts), for sites that block or treat a server's address differently. The other
 * computer runs its own web_fetch with all its checks; this node only sends the address and reads the text back.
 */
import type { Tool } from '@agent/core'

import { RELAY_FETCH } from '../main/devices/relay'
import type { DeviceFacts } from '../main/devices/types'
import type { Secrets } from '../main/secrets'
import { PASS_SECRET } from './pair'
import { callNode } from './rpc-client'

export interface RelayTarget {
  id: string
  name: string
  urls: string[]
  fp: string
}

export interface RelayToolDeps {
  secrets: Secrets
  selfId: () => string
  facts: () => DeviceFacts
  /** Paired computers that may relay (brains and hands with an address), best first. */
  targets: () => Promise<RelayTarget[]>
}

export function relayTool(deps: RelayToolDeps): Tool {
  return {
    spec: {
      name: 'web_fetch_via_device',
      description:
        "Fetch a web address through one of the person's own other computers (its internet connection), when a site blocks this server, shows a captcha wall, or answers differently by location. Same as web_fetch otherwise: text only, public addresses only.",
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'An https:// web address' },
          device: { type: 'string', description: 'Which computer to go through, by name. Leave out for the first one that answers.' },
          maxChars: { type: 'integer', description: 'How much text to return, at most 12000 characters' },
        },
        required: ['url'],
      },
    },
    run: async (input) => {
      const url = typeof input['url'] === 'string' ? input['url'].trim() : ''
      if (url === '') return 'Pass the web address to fetch.'
      const pass = deps.secrets.get(PASS_SECRET) ?? ''
      if (pass === '') return 'This server is not paired with another computer yet, so there is nothing to fetch through. Pair it first (agent-node pair).'
      const wanted = typeof input['device'] === 'string' ? input['device'].trim().toLowerCase() : ''
      const all = (await deps.targets()).filter((t) => t.id !== deps.selfId() && t.urls.length > 0 && t.fp !== '')
      const targets = wanted === '' ? all : all.filter((t) => t.name.toLowerCase().includes(wanted))
      if (targets.length === 0) return wanted === '' ? 'None of your other computers can be reached from here.' : `No paired computer is called ${wanted}.`
      const request = { url, ...(typeof input['maxChars'] === 'number' ? { maxChars: input['maxChars'] } : {}) }
      const tried: string[] = []
      for (const target of targets) {
        for (const base of target.urls) {
          try {
            const text = await callNode(base, target.fp, pass, deps.facts(), RELAY_FETCH, [request], 45_000)
            return `Fetched through ${target.name}:\n${String(text)}`
          } catch (error) {
            tried.push(`${target.name}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      return `Could not fetch through your other computers. ${tried.slice(0, 3).join(' ')}`
    },
  }
}
