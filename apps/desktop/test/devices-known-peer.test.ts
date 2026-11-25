/**
 * A joining node that cannot open connections out (a firewall, a userspace VPN) only ever hears from the brain it
 * paired with. The brain's first replication push must be let in although its device row has not arrived yet; the
 * row, once here, wins (revoked stays revoked). Found in the live cross-machine test, 22 Oct 2026.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { registerSyncRoutes } from '../src/main/devices/replicate'
import { PairingOffers, handlePair } from '../src/main/devices/pairing'
import { hashPass, newPass } from '../src/main/devices/passes'
import { HandlerRegistry } from '../src/main/devices/registry'
import { DevicesService } from '../src/main/devices/service'
import type { DeviceRole } from '../src/main/devices/types'
import { pinnedRequest } from './devices-client'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const done of cleanups.splice(0).reverse()) await done()
})

async function node(knownPeer?: (id: string) => DeviceRole[] | null): Promise<{ service: DevicesService; store: Store; base: string; fp: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-peer-'))
  const store = new Store(join(dir, 'agent.db'))
  const data = new Map<string, string>()
  const service = new DevicesService({
    userData: dir,
    store,
    secrets: { get: (n) => data.get(n) ?? null, set: (n, v) => void data.set(n, v), delete: (n) => void data.delete(n) },
    registry: new HandlerRegistry(),
    appVersion: '1.0.0',
    nodeName: () => 'Joining server',
    platform: 'linux',
    ready: () => true,
    busy: () => false,
    rendererDir: join(dir, 'none'),
    emitWindow: () => undefined,
    kind: 'server',
    ...(knownPeer === undefined ? {} : { knownPeer }),
  })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => store.close(), () => service.stop())
  registerSyncRoutes(service.host(), store)
  await service.start()
  let status = service.status()
  for (let attempt = 0; attempt < 5 && !status.running; attempt += 1) {
    await service.configure({ listen: '127.0.0.1', port: 20000 + Math.floor(Math.random() * 30000) })
    status = await service.setEnabled(true)
  }
  return { service, store, base: `https://127.0.0.1:${status.port}`, fp: status.fp }
}

describe('a joining node lets in the brain it paired with before that brain\'s row arrives', () => {
  it('accepts the brain\'s pass with no row through knownPeer, and a revoked row still refuses it', async () => {
    const brainId = 'dev_brain_desk'
    const pass = newPass()
    const joined = await node((id) => (id === brainId ? ['brain', 'hands'] : null))
    // The bundle brought the brain's pass hash; its device row has not come yet.
    joined.service.passTable().set(brainId, hashPass(pass))
    const devices = () => pinnedRequest(`${joined.base}/v1/devices`, joined.fp, { headers: { Authorization: `Bearer ${pass}` } })
    expect((await devices()).status).toBe(200)
    // Node-only routes too: the brain is a brain.
    const other = await pinnedRequest(`${joined.base}/v1/devices/nobody/revoke`, joined.fp, { method: 'POST', headers: { Authorization: `Bearer ${pass}` } })
    expect(other.status).toBe(404)

    await joined.store.upsert('device', { id: brainId, name: 'Desk', kind: 'desktop', platform: 'windows', roles: ['brain', 'hands'], priority: 0, urls: [], fp: '', facts: {} as never, pairedAt: 1, lastSeen: 1, revoked: true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect((await devices()).status).toBe(401)
  })

  it('without knownPeer a pass with no row is refused, as before', async () => {
    const plain = await node()
    const pass = newPass()
    plain.service.passTable().set('dev_someone', hashPass(pass))
    expect((await pinnedRequest(`${plain.base}/v1/devices`, plain.fp, { headers: { Authorization: `Bearer ${pass}` } })).status).toBe(401)
  })
})

it('R7-B1 fresh pairing bootstraps the host authority before its first pull', async () => {
  const host = await node(),
    joined = await node()
  const hostId = host.service.identity.nodeId
  expect(await joined.store.get('device', hostId)).toBeNull()
  await host.store.upsert('device', {
    id: hostId,
    prGatePublicKey: 'paired-host-key',
  })
  await expect
    .poll(
      () =>
        host.service.list().find((row) => row.id === hostId)?.prGatePublicKey,
    )
    .toBe('paired-host-key')
  const link = host.service
    .offer()
    .uri.replace(/([?&])u=[^&]*/, '$1u=' + encodeURIComponent(host.base))
  await joined.service.join(link)
  expect(await joined.store.get('device', hostId)).toMatchObject({
    roles: ['brain', 'hands'],
    prGatePublicKey: 'paired-host-key',
  })
  await joined.store.applyRemote(host.store.changesAfter(0).changes, hostId)
  expect((await joined.store.get('device', hostId))?.prGatePublicKey).toBe(
    'paired-host-key',
  )
})
it('R7-m5 refreshing a demoted desktop does not restore its brain role', async () => {
  const self = await node(),
    id = self.service.identity.nodeId
  await self.store.upsert('device', { id, roles: ['hands'] })
  await expect
    .poll(() => self.service.list().find((row) => row.id === id)?.roles)
    .toEqual(['hands'])
  await self.service.configure({ port: self.service.status().port })
  expect((await self.store.get('device', id))?.roles).toEqual(['hands'])
})


it('R11-N2 revoke then forget on another brain invalidates the host pass permanently', async () => {
  const host = await node(), brain = await node()
  const phone = 'dev_r11_phone', pass = newPass()
  await brain.store.upsert('device', { id: phone, name: 'Phone', kind: 'phone', platform:'android', roles:['hands','screen'], priority:0, urls:[], fp:'phone-pin', pairedAt:1, lastSeen:1, revoked:false })
  await host.store.applyRemote(brain.store.changesAfter(0).changes, '')
  await new Promise(resolve => setTimeout(resolve,100))
  host.service.passTable().set(phone, hashPass(pass))
  await brain.store.upsert('device', {id:phone,lastSeen:2})
  await host.store.applyRemote(brain.store.changesAfter(0).changes, '')
  await new Promise(resolve => setTimeout(resolve,100))
  const devices = () => pinnedRequest(host.base+'/v1/devices',host.fp,{headers:{Authorization:'Bearer '+pass}})
  expect((await devices()).status).toBe(200)
  await new Promise(resolve => setTimeout(resolve,100))
  await brain.service.revoke(phone)
  await host.store.applyRemote(brain.store.changesAfter(0).changes, '')
  await new Promise(resolve => setTimeout(resolve,100))
  expect((await devices()).status).toBe(401)
  await brain.service.forget(phone)
  await host.store.applyRemote(brain.store.changesAfter(0).changes, '')
  await new Promise(resolve => setTimeout(resolve,100))
  expect(host.service.passTable().deviceFor(pass)).toBeNull()
  expect((await devices()).status).toBe(401)
  const push = await pinnedRequest(host.base+'/v1/sync/push',host.fp,{
    method:'POST',headers:{Authorization:'Bearer '+pass,'content-type':'application/json'},
    body:{changes:[{entity:'device',id:phone,payload:{id:phone,roles:['hands'],revoked:false}}]}
  })
  expect(push.status).toBe(401)
  expect(await host.store.get('device',phone)).toBeNull()
})


it('R12 M1 two brains accept a later same-id pairing and reject old hashes',async()=>{
  const a=await node(),b=await node(),id='dev_repair_computer',old=newPass()
  const first=Date.now()-10000
  await a.store.upsert('device',{id,name:'Computer',kind:'desktop',platform:'linux',roles:['brain'],pairedAt:first,lastSeen:first,revoked:false})
  a.service.passTable().set(id,hashPass(old),first)
  await new Promise(resolve=>setTimeout(resolve,100))
  await a.service.revoke(id)
  await b.store.applyRemote(a.store.changesAfter(0).changes,'')
  await new Promise(resolve=>setTimeout(resolve,100))
  const now=Date.now()+1000,offers=new PairingOffers(()=>now),offer=offers.create()
  const result=await handlePair({code:offer.secret,nodeId:id,wantRoles:['brain'],device:{kind:'desktop',platform:'linux',fingerprint:'f'.repeat(43)}},{
    offers,passes:b.service.passTable(),meshId:'mesh_fixture',node:{id:b.service.identity.nodeId,name:'B'},now:()=>now,nextPriority:async()=>1,brains:async()=>[],
    saveDevice:async row=>{await b.store.upsert('device',row)}
  })
  expect(result.status).toBe(200)
  if(result.status!==200)throw new Error('pair failed')
  await a.store.applyRemote(b.store.changesAfter(0).changes,'')
  await new Promise(resolve=>setTimeout(resolve,100))
  const bp=b.service.passTable()
  a.service.passTable().replaceAll(bp.all(),(bp as unknown as {authority?:()=>never}).authority?.())
  const read=(pass:string)=>pinnedRequest(a.base+'/v1/devices',a.fp,{headers:{Authorization:'Bearer '+pass}})
  expect((await read(result.json.pass)).status).toBe(200)
  expect((await read(old)).status).toBe(401)
})


it('R12 M1 joining a host again clears the local older deny',async()=>{
  const host=await node(),joined=await node()
  const link=()=>host.service.offer().uri.replace(/([?&])u=[^&]*/,'$1u='+encodeURIComponent(host.base))
  await joined.service.join(link())
  const id=host.service.identity.nodeId
  await joined.service.revoke(id)
  expect(joined.service.passTable().rolesFor(id)).toBeNull()
  await joined.service.join(link())
  const row=await joined.store.get('device',id)
  expect(row?.revoked).toBe(false)
  // The local deny must not override the explicitly renewed host row.
  expect(joined.service.passTable().isRevoked(id)).toBe(false)
})

it('R13 m1 a delete that arrives late denies only the pairing this brain knew', async () => {
  const a = await node(), b = await node(), id = 'dev_late_forget', old = newPass()
  const first = Date.now() - 10000
  await a.store.upsert('device', { id, name: 'Computer', kind: 'desktop', platform: 'linux', roles: ['brain'], pairedAt: first, lastSeen: first, revoked: false })
  a.service.passTable().set(id, hashPass(old), first)
  await new Promise(resolve => setTimeout(resolve, 100))
  await b.store.applyRemote(a.store.changesAfter(0).changes, '')
  await new Promise(resolve => setTimeout(resolve, 100))
  await b.service.forget(id)
  // Brain A hears of the delete late. Its deny must stay with the pairing it held, not take this brain's clock.
  await new Promise(resolve => setTimeout(resolve, 250))
  await a.store.applyRemote(b.store.changesAfter(0).changes, '')
  await new Promise(resolve => setTimeout(resolve, 100))
  const state = a.service.passTable().authority()[id]
  expect(state?.deniedAt).toBe(first)
  expect(a.service.passTable().isRevoked(id)).toBe(true)
  // A pairing issued after the forget is therefore let in.
  a.service.passTable().replaceAll({ [id]: hashPass('new') }, { [id]: { pairedAt: first + 1, deniedAt: -1, roles: ['brain'] } })
  expect(a.service.passTable().isRevoked(id)).toBe(false)
  expect(a.service.passTable().all()[id]).toBe(hashPass('new'))
  expect(a.service.passTable().all()[id]).not.toBe(hashPass(old))
})
