import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/main/db'
import { Runner } from '../src/main/runtime/runner'
import { ActsForMe } from '../src/main/runtime/acts-for-me'
import { DeviceQuestions } from '../src/main/devices/device-questions'
import { classifyCard } from '../src/shared/approval-policy'
import { callLearned } from '../src/main/tools/webapps'
import type { LearnedApp, LearnedTool } from '../src/main/apps/store'
import { settingsView, secretsView, testContext } from './support'
import { waitFor } from '../../../packages/core/test/helpers'

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()))
const request = { id: 'real', at: 1, text: 'Send the report to ben@example.org' }
it.each(['sendMoney', 'send_money', 'sendSecret', 'sendApiKey'])('keeps %s person-only with a recipient-naming request', tool => {
  expect(classifyCard({kind:'approval',asker:'helper',summary:'Operation',request,origin:{tool:'webapp_run',input:{tool,args:{to:'ben@example.org',amount:100}}}}).lane).toBe('him')
})
it('never converts a connector payment to requested outbound authorization', () => {
  expect(classifyCard({kind:'approval',asker:'helper',summary:'Operation',request,origin:{tool:'apps_run',input:{slug:'WISE_SEND_MONEY',arguments:{to:'ben@example.org',amount:100}}}}).lane).toBe('him')
})
it('does not treat an explicit prohibition as a send request', () => {
  expect(classifyCard({kind:'approval',asker:'helper',summary:'Send',request:{...request,text:'Do not send to ben@example.org'},origin:{tool:'webapp_run',input:{tool:'send_email',args:{to:'ben@example.org'}}}}).lane).toBe('him')
})
function setup() {
  const store = new Store(':memory:'); cleanup.push(() => store.close())
  const settings = settingsView()
  let runner: Runner
  const acts = new ActsForMe({store,settings,decide:async(id,decision,by)=>runner.decide(id,decision,by),answerQuestion:async(id,answer,by)=>runner.answer(id,answer,by),postToMain:async()=>undefined,hasWaiter:()=>true,liveHelpers:()=>new Set(),chatRunning:()=>true,needsYou:()=>undefined,changed:()=>undefined,tellAsker:async()=>undefined})
  cleanup.push(() => acts.dispose())
  runner = new Runner({store,settings,acts,secrets:secretsView(null),tools:[],emit:()=>undefined,notify:()=>undefined,isFocused:()=>false,timeZone:'UTC'})
  cleanup.push(() => runner.dispose())
  return {store,runner,acts}
}
it('reads the actual producer flat body, rather than a test-only nested request', async () => {
  const {store,runner} = setup()
  const original = await store.upsert('chat_item',{kind:'user',text:request.text,meta:'{}'})
  const row = await store.upsert('device_command',{kind:'tool',tool:'webapp_run',chat:'main',owner:'helper:child',target:'hands',brainId:'brain',status:'sent',expiresAt:Date.now()+600000,body:JSON.stringify({id:original.id,at:original.createdAt,text:original.text})})
  const ctx = await runner.recordedDeviceToolContext(new AbortController().signal,{id:row.id,tool:'webapp_run',chatId:'main'})
  expect(ctx.requestId).toBe(original.id)
})
it('an unbound remote routine cannot borrow a newer unrelated user request for its card', async () => {
  const {store,runner} = setup()
  const original = await store.upsert('chat_item',{kind:'user',text:'Unrelated latest user message',meta:'{}'})
  const stop = new AbortController()
  const ctx = runner.deviceToolContext(stop.signal,{chatId:'main',owner:'routine'})
  const pending = ctx.approve('Restart service','',undefined,{tool:'webapp_run',input:{tool:'restart_service'}})
  await waitFor(async () => (await store.list('chat_item')).some(r=>r.kind==='approval'))
  const row = (await store.list('chat_item')).find(r=>r.kind==='approval')!
  stop.abort(); await pending
  expect(JSON.parse(row.meta).request, `unrelated row ${original.id} must not be linked`).toBeUndefined()
})
it('a canceled context remains canceled after the regular prune operation', async () => {
  const store = new Store(':memory:'); cleanup.push(() => store.close())
  const row = await store.upsert('device_command',{kind:'tool',tool:'webapp_test',chat:'main',brainId:'brain',target:'phone',status:'sent',expiresAt:10000})
  const stop = new AbortController()
  const bridge = new DeviceQuestions(store,()=> 'brain',()=>100)
  bridge.remember(row.id,testContext({signal:stop.signal}),10000)
  stop.abort(); bridge.prune()
  expect(await bridge.ask('phone',[row.id,1,'APPROVAL|Operation|Details',['Approve','Decline']])).toEqual({handled:true,answer:null})
})
it.each([['helper:child','main'],['chat:pc123456','pc123456'],['routine','main']])('Undo holds the next remote %s card for the person using the same asker identity', async (owner,chatId) => {
  const {store,runner,acts} = setup()
  const stop = new AbortController()
  const ctx = runner.deviceToolContext(stop.signal,{chatId,owner})
  const origin = {tool:'webapp_run',input:{tool:'update_service'}}
  const first = ctx.approve('Restart service','',undefined,origin)
  await waitFor(async()=>(await acts.waiting()).length===1)
  const card = (await acts.waiting())[0]!
  expect(await acts.answer({id:card.id,action:'decline',reason:'Not needed'})).toMatchObject({ok:true})
  expect(await first).toBe(false)
  expect(await acts.undo(card.id)).toMatchObject({ok:true})
  const second = ctx.approve('Restart again','',undefined,origin)
  await waitFor(async()=>(await store.list('chat_item')).filter(r=>r.kind==='approval').length===2)
  const next = (await store.list('chat_item')).find(r=>r.kind==='approval'&&r.id!==card.id)!
  stop.abort(); await second
  expect(JSON.parse(next.meta).lane).toBe('him')
})
it('real learned-tool queue cannot auto-approve sendMoney under an unrelated report-send request', async () => {
  const {store,runner,acts} = setup()
  const source = await store.upsert('chat_item',{kind:'user',text:request.text,meta:'{}'})
  const stop = new AbortController()
  const ctx = runner.deviceToolContext(stop.signal,{chatId:'main',owner:'helper:child',request:{id:source.id,at:source.createdAt,text:source.text}})
  const tool: LearnedTool = {name:'sendMoney',description:'Transfer funds',params:{},required:[],js:'return "simulated"',readOnly:false,asksFirst:true}
  const app: LearnedApp = {id:'synthetic',name:'Synthetic test',startUrl:'https://example.org',about:'',tools:[tool],trusted:false,updatedAt:1}
  let executions = 0
  const pending = callLearned(app,tool,{to:'ben@example.org',amount:100},ctx,{ensure:async()=>undefined,evaluate:async()=>undefined,run:async()=>{executions++;return {ok:true,v:'simulated'}}})
  await waitFor(async()=>(await store.list('chat_item')).some(r=>r.kind==='approval'))
  const card = (await store.list('chat_item')).find(r=>r.kind==='approval')!
  const decision = await acts.answer({id:card.id,action:'approve',reason:'The user requested a report send'})
  if (!decision.ok) stop.abort()
  await pending
  stop.abort()
  expect({approved:decision.ok,executions}).toEqual({approved:false,executions:0})
})
