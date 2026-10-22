/**
 * `agent-node pair`: join a person's mesh from a pairing link (QR text) or an address plus short code (protocol s3),
 * then take in the state bundle (s6). Every request is pinned to the certificate named in the link; with a short code
 * the certificate is trusted on first use and its fingerprint shown.
 */
import { join } from 'node:path'

import { joinMesh, loadIdentity } from '../main/devices/identity'
import type { BrainRef, DeviceFacts } from '../main/devices/types'
import type { Secrets } from '../main/secrets'
import { applyBundle, type ApplyResult, type BundleTargets } from './bundle'
import { writeConfig, type NodeConfig } from './node-config'
import { pinnedJson } from './pinned'

export interface PairTarget {
  urls: string[]
  code: string
  /** '' when pairing by short code (trust on first use). */
  fp: string
  meshId: string
  nodeId: string
  name: string
}

const SHORT_CODE = /^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/

export function parsePairLink(link: string): PairTarget {
  let url: URL
  try {
    url = new URL(link.trim())
  } catch {
    throw new Error('That is not a pairing link. It starts with agent://pair?')
  }
  if (url.protocol !== 'agent:' || (url.hostname !== 'pair' && !url.pathname.replace(/^\/+/, '').startsWith('pair'))) {
    throw new Error('That is not a pairing link. It starts with agent://pair?')
  }
  const q = url.searchParams
  const urls = (q.get('u') ?? '').split(',').map((u) => u.trim()).filter((u) => /^https:\/\//i.test(u))
  const code = q.get('c') ?? ''
  const fp = q.get('fp') ?? ''
  if (urls.length === 0 || code === '' || fp === '') throw new Error('The pairing link is missing its address, code or fingerprint.')
  return { urls, code, fp, meshId: q.get('mesh') ?? '', nodeId: q.get('node') ?? '', name: q.get('name') ?? '' }
}

export function shortCodeTarget(address: string, code: string): PairTarget {
  const clean = code.trim().toUpperCase()
  if (!SHORT_CODE.test(clean)) throw new Error('The short code is 8 letters and digits, like ABCD-EFGH.')
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(address) ? address : `https://${address}`)
  } catch {
    throw new Error('That address does not look right. Use https://host:port.')
  }
  if (url.protocol !== 'https:') throw new Error('Nodes only talk over https.')
  if (url.port === '') url.port = '7787'
  const normalised = clean.includes('-') ? clean : `${clean.slice(0, 4)}-${clean.slice(4)}`
  return { urls: [url.origin], code: normalised, fp: '', meshId: '', nodeId: '', name: '' }
}

interface PairAnswer {
  deviceId: string
  pass: string
  meshId: string
  node: { id: string; name: string }
  brains: BrainRef[]
}

function readAnswer(json: unknown): PairAnswer {
  const o = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>
  const node = (typeof o['node'] === 'object' && o['node'] !== null ? o['node'] : {}) as Record<string, unknown>
  if (typeof o['pass'] !== 'string' || o['pass'] === '' || typeof o['deviceId'] !== 'string') {
    throw new Error('The other device did not hand back a pass.')
  }
  return {
    deviceId: o['deviceId'],
    pass: o['pass'],
    meshId: typeof o['meshId'] === 'string' ? o['meshId'] : '',
    node: { id: typeof node['id'] === 'string' ? node['id'] : '', name: typeof node['name'] === 'string' ? node['name'] : '' },
    brains: Array.isArray(o['brains']) ? (o['brains'] as BrainRef[]) : [],
  }
}

export interface PairOutcome {
  url: string
  fp: string
  deviceId: string
  meshId: string
  bundle: ApplyResult | null
  bundleError: string
}

/** Secret names the devices work adds (B extends SecretName when merged). */
export const PASS_SECRET = 'devicePass'

export async function pair(
  target: PairTarget,
  facts: DeviceFacts,
  config: NodeConfig,
  dataDir: string,
  targets: BundleTargets & { secrets: Secrets },
): Promise<PairOutcome> {
  let lastError = ''
  for (const url of target.urls) {
    let reply
    try {
      reply = await pinnedJson(`${url.replace(/\/+$/, '')}/v1/pair`, {
        method: 'POST',
        fp: target.fp,
        body: { code: target.code, device: facts, wantRoles: ['brain', 'hands'] },
      })
    } catch (error) {
      lastError = `${url}: ${error instanceof Error ? error.message : String(error)}`
      continue
    }
    if (reply.status !== 200) {
      const message = (reply.json as { error?: unknown } | null)?.error
      throw new Error(`Pairing was refused (${reply.status}): ${typeof message === 'string' ? message : 'no reason given'}`)
    }
    const answer = readAnswer(reply.json)
    targets.secrets.set(PASS_SECRET as Parameters<Secrets['set']>[0], answer.pass)
    const brains = answer.brains.length > 0
      ? answer.brains
      : [{ id: answer.node.id || target.nodeId, name: answer.node.name || target.name, urls: target.urls, fp: reply.fp, priority: 0 }]
    const next: NodeConfig = { ...config, meshId: answer.meshId, deviceId: answer.deviceId, brains }
    writeConfig(dataDir, next)
    Object.assign(config, next)
    // This node now belongs to that mesh; it keeps its own id and certificate.
    const devicesDir = join(dataDir, 'devices')
    if (answer.meshId !== '') joinMesh(devicesDir, loadIdentity(devicesDir), answer.meshId)

    let bundle: ApplyResult | null = null
    let bundleError = ''
    try {
      const pulled = await pinnedJson(`${url.replace(/\/+$/, '')}/v1/bundle`, { fp: reply.fp, pass: answer.pass })
      if (pulled.status !== 200) throw new Error(`the bundle answered ${pulled.status}`)
      bundle = await applyBundle(targets, pulled.json)
    } catch (error) {
      bundleError = error instanceof Error ? error.message : String(error)
    }
    return { url, fp: reply.fp, deviceId: answer.deviceId, meshId: answer.meshId, bundle, bundleError }
  }
  throw new Error(`Could not reach the other device. ${lastError}`)
}
