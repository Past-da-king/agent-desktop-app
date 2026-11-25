import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type JsonObject } from '@agent/core'
import { Store } from '../src/main/db'
import { PrGate, ATTESTATION_FIELDS, gateForTools } from '../src/main/runtime/pr-gate'
import { buildWorkerToolset } from '../src/main/runtime/toolset'
import { planPermission, planToolContext, toolsForTurn } from '../src/main/runtime/cli-host'
import { codexSettings } from '../src/main/runtime/cli-agent'
import { classifyCard } from '../src/shared/approval-policy'
import { SETTINGS_NEED_APPROVAL } from '../src/main/tools/app-control'
import { SHARED_SETTINGS } from '../src/main/devices/bundle'
import { setVaultRedactor } from '../src/main/vault/redact'
import { testContext,toolNamed } from './support'
const stores:Store[]=[]
afterEach(()=>{stores.splice(0).forEach(s=>s.close());setVaultRedactor(null)})
function setup(){
 const store=new Store(':memory:');stores.push(store)
 const settings={...DEFAULT_SETTINGS,shell:'always' as const,prGateEnabled:true,prGateSkillPages:[] as string[]}
 const tools=buildWorkerToolset({store,settings:{get:()=>settings}})
 const ctx=testContext({owner:'helper:author',agentLabel:'author-agent',chat:'project'})
 return {store,settings,tools,ctx}
}
const proof=()=>Object.fromEntries(ATTESTATION_FIELDS.map(k=>[k,k==='reviewerAgentId'?'helper:independent-reviewer':'Specific verified evidence at /tmp/proof.md for '+k]))
describe('review findings: protection, private engine path and launch parity',()=>{
 it('requires the person for settings and policy approval, including automatic approval classification',()=>{
  for(const key of ['prGateEnabled','prGateSkillPages']){
   expect(SETTINGS_NEED_APPROVAL.has(key)).toBe(true)
   expect(SHARED_SETTINGS).toContain(key)
   expect(classifyCard({kind:'approval',asker:'helper',summary:'Update a setting',origin:{tool:'settings_set',input:{values:{[key]:false}}}}).lane).toBe('him')
  }
  expect(classifyCard({kind:'approval',asker:'helper',summary:'Edit policy',origin:{tool:'pr_gate_policy',input:{title:'Review policy'}}}).lane).toBe('him')
 })
 it('cannot rewrite configured policy pages through memory or app_action without the person',async()=>{
  const t=setup();t.settings.prGateSkillPages=['Review policy']
  const page=await t.store.upsert('memory',{title:'Review policy',body:'Original checklist',kind:'fact',topics:'review',pinned:false,source:'user'})
  for(const [tool,args] of [
   ['memory_save',{title:'Review policy',body:'weakened',kind:'fact',topics:'review'}],
   ['memory_update',{id:page.id,body:'weakened'}],
   ['app_action',{method:'data.upsert',args:['memory',{id:page.id,body:'weakened'}]}],
  ] as Array<[string,JsonObject]>){
   expect(await gateForTools(t.tools)!.check(tool,args,t.ctx)).toContain('Refused')
  }
  expect((await t.store.get('memory',page.id))!.body).toBe('Original checklist')
 })
 it('never exposes the private permission handle, gates actual SDK permission and leaves Claude copies out',async()=>{
  const t=setup()
  expect(t.tools.some(tool=>tool.spec.name==='pr_gate_check')).toBe(false)
  expect(toolsForTurn({tools:t.tools,cli:'claude',thread:'helper:author'}).some(tool=>tool.spec.name==='shell_run')).toBe(false)
  const base=vi.fn(async()=>({allow:true as const}))
  const permission=planPermission({tools:t.tools,context:t.ctx},()=>t.settings,base)
  const held=await permission('Bash',{command:'gh pr ready 3'})
  expect(held.allow).toBe(false);expect(base).not.toHaveBeenCalled()
  if(held.allow)throw Error('Gate did not hold')
  const id=held.message.match(/Gate id: ([a-f0-9-]+)/)![1]!
  await toolNamed(t.tools,'pr_gate_attest').run({gateId:id,attestation:proof()},t.ctx)
  expect(await permission('Bash',{command:'gh pr ready 3',description:'A different description',timeout:900000})).toEqual({allow:true})
  // Round 9 B1: the Claude permission check does not spend the grant; the gh shim spends it when the action really runs (see the round 9 end-to-end test).
  expect(await permission('Bash',{command:'gh pr ready 3'})).toEqual({allow:true})
  t.settings.prGateEnabled=false
  expect(toolsForTurn({tools:t.tools,cli:'claude',thread:'helper:author'}).some(tool=>tool.spec.name==='shell_run')).toBe(false)
  expect(await permission('PowerShell',{command:'gh pr ready 3'})).toEqual({allow:true})
 })
 it('preserves Codex sandbox, network and project cwd while using app command tools',()=>{
  const t=setup()
  const launch=codexSettings({workDir:'/tmp/private',folder:'/tmp/project',access:'free',appCommandsOnly:true,mcp:{url:'http://127.0.0.1:1',token:'t'}})
  expect(launch.thread.sandboxMode).toBe('danger-full-access')
  expect(launch.thread.networkAccessEnabled).toBe(true)
  expect((launch.config['features'] as Record<string,unknown>)['shell_tool']).toBe(false)
  const context=planToolContext({cli:'codex',context:t.ctx,folder:process.cwd()},t.settings)
  expect(context.commandFallback?.cwd).toBe(process.cwd())
  expect(context.commandFallback!.timeoutSec).toBeGreaterThan(600)
  expect(context.resultLimit).toBeUndefined()
  expect(planToolContext({cli:'claude',context:t.ctx},t.settings)).toBe(t.ctx)
 })
})
describe('review findings: grant lifetime, redaction and bounded audit',()=>{
 it('allows a long review, then exactly 60 minutes from attestation, and ignores descriptions',async()=>{
  const t=setup();let now=1_000_000
  const gate=new PrGate(t.store,()=>t.settings,()=>now),input={command:'gh pr ready 3'}
  const held=await gate.check('shell_run',input,t.ctx),id=held!.match(/Gate id: ([a-f0-9-]+)/)![1]!
  now+=2*60*60_000
  expect(await gate.attest(id,proof(),t.ctx)).toContain('recorded')
  now+=59*60_000
  expect(await gate.check('shell_run',{...input,description:'retry',timeoutSec:60},t.ctx)).toBeNull()
  const held2=await gate.check('shell_run',input,t.ctx),id2=held2!.match(/Gate id: ([a-f0-9-]+)/)![1]!
  await gate.attest(id2,proof(),t.ctx);now+=60*60_000+1
  expect(await gate.check('shell_run',input,t.ctx)).toContain('NOT RUN')
 })
 it('refuses long boilerplate, redacts evidence and deduplicates repeated holds',async()=>{
  const t=setup(),gate=gateForTools(t.tools)!,input={command:'gh pr ready 3'}
  const held=await gate.check('shell_run',input,t.ctx),id=held!.match(/Gate id: ([a-f0-9-]+)/)![1]!
  expect(await gate.attest(id,Object.fromEntries(ATTESTATION_FIELDS.map(k=>[k,'not applicable'])),t.ctx)).toContain('Refused')
  expect(await gate.attest(id,{...proof(),trialMergeAndSuite:'not applicable'},t.ctx)).toContain('Refused')
  await gate.check('shell_run',input,t.ctx)
  expect((await t.store.list('chat_item')).filter(r=>r.text==='held for attestation')).toHaveLength(1)
  const writes=vi.spyOn(t.store,'upsert')
  setVaultRedactor(text=>text.replaceAll('fixture-secret-value','[vault:fixture]'))
  await gate.attest(id,{...proof(),testProof:'/tmp/fixture-secret-value/proof.md'},t.ctx)
  expect(JSON.stringify(await t.store.list('chat_item'))).not.toContain('fixture-secret-value')
  expect(JSON.stringify(writes.mock.calls)).not.toContain('fixture-secret-value')
 })
 it('keeps at most 500 audit rows',async()=>{
  const t=setup(),gate=gateForTools(t.tools)!
  for(let n=0;n<502;n++)await gate.check('shell_run',{command:'gh pr ready '+n},t.ctx)
  expect((await t.store.list('chat_item')).filter(r=>r.kind==='pr_gate')).toHaveLength(500)
 },30_000)
})

it('holds review approvals for evidence',async()=>{
 const t=setup()
 expect(await gateForTools(t.tools)!.check('shell_run',{command:'gh pr review 3 --approve'},t.ctx)).not.toBeNull()
 expect((await t.store.list('chat_item')).some(row=>row.text==='review approval (not gated)')).toBe(false)
})
