import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Store } from '../src/main/db'
import { Runner } from '../src/main/runtime/runner'
import { ActsForMe } from '../src/main/runtime/acts-for-me'
import { AppGuard } from '../src/main/apps/guard'
import { appTools } from '../src/main/tools/apps'
import type { AppsService } from '../src/main/apps/service'
import { HelperDetail } from '../src/renderer/shell/HelpersPanel'
import { settingsView, secretsView, toolNamed } from './support'
import { waitFor } from '../../../packages/core/test/helpers'
import { stampCard, verdictOfRow } from '../src/shared/card-state'
import { classifyCard } from '../src/shared/approval-policy'
vi.mock('../src/renderer/bridge', () => ({agent:{},chat:{}}))
const cleanup:Array<()=>void>=[]
afterEach(()=>cleanup.splice(0).reverse().forEach(fn=>fn()))
it('HelperDetail displays request and recommendation from real helper and approval row shapes',()=>{
 const source={id:'stored-user',at:1795605660000,text:'Unique original request to read the shared folder'}
 const helper={id:'child',kind:'helper',createdAt:1,text:'Work on the task',meta:JSON.stringify({id:'child',label:'Child',state:'working',requestId:source.id,startedAt:1})}
 const card={id:'pending',kind:'approval',createdAt:2,text:'Read folder',meta:JSON.stringify({helper:'child',request:source,escalatedWhy:'Unique recommendation for the requested read'})}
 const user={id:source.id,kind:'user',createdAt:source.at,text:source.text,meta:'{}'}
 const html=renderToStaticMarkup(createElement(HelperDetail,{id:'child',items:[user,helper,card],projects:[],onClose:()=>undefined}))
 expect(html).toContain(source.text)
 expect(html).toContain('Unique recommendation for the requested read')
})
it('a real connected-app named-recipient send retains its actual arguments and can reach main review',async()=>{
 const store=new Store(':memory:');cleanup.push(()=>store.close())
 const settings=settingsView();let runner:Runner
 const acts=new ActsForMe({store,settings,decide:async(id,d,by)=>runner.decide(id,d,by),answerQuestion:async(id,a,by)=>runner.answer(id,a,by),postToMain:async()=>undefined,hasWaiter:()=>true,liveHelpers:()=>new Set(),chatRunning:()=>true,needsYou:()=>undefined,changed:()=>undefined})
 cleanup.push(()=>acts.dispose())
 runner=new Runner({store,settings,acts,secrets:secretsView(null),tools:[],emit:()=>undefined,notify:()=>undefined,isFocused:()=>false,timeZone:'UTC'});cleanup.push(()=>runner.dispose())
 const user=await store.upsert('chat_item',{kind:'user',text:'Send the update to ben@example.org',meta:'{}'})
 const stop=new AbortController();cleanup.push(()=>stop.abort())
 const ctx=runner.deviceToolContext(stop.signal,{chatId:'main',owner:'helper:child',request:{id:user.id,at:user.createdAt,text:user.text}})
 let executions=0
 const guard=new AppGuard({rulesFor:()=>({read:'allow',change:'ask'}),accountsFor:async()=>[]})
 const apps={guard,backend:()=>({execute:async()=>{executions++;return {ok:true,text:'simulated'}}})} as unknown as AppsService
 const task=toolNamed(appTools(apps),'apps_run').run({slug:'GMAIL_SEND_EMAIL',arguments:{to:'ben@example.org',body:'Requested report'}},ctx)
 await waitFor(async()=>(await store.list('chat_item')).some(r=>r.kind==='approval'))
 const card=(await store.list('chat_item')).find(r=>r.kind==='approval')!
 const decision=await acts.answer({id:card.id,action:'approve',reason:'The app-recorded request explicitly names the send and recipient'})
 if(!decision.ok)stop.abort()
 await task;stop.abort()
 expect({approved:decision.ok,executions}).toEqual({approved:true,executions:1})
})
it('an unbound helper-result turn cannot borrow the last unrelated accepted user request',async()=>{
 const store=new Store(':memory:');cleanup.push(()=>store.close())
 const original=await store.upsert('chat_item',{kind:'user',text:'Read the earlier shared folder',meta:'{}'})
 await store.upsert('chat_item',{kind:'helper',text:'Read the earlier shared folder',meta:JSON.stringify({id:'earlier-child',label:'Earlier child',state:'done',requestId:original.id})})
 const user=await store.upsert('chat_item',{kind:'user',text:'Send the separate report to ben@example.org',meta:'{}'})
 const runner=new Runner({store,settings:settingsView(),secrets:secretsView(null),tools:[],emit:()=>undefined,notify:()=>undefined,isFocused:()=>false,timeZone:'UTC'});cleanup.push(()=>runner.dispose())
 const internal=runner as unknown as {line(chat:string):{requestId?:string};drive():Promise<undefined>}
 internal.line('main').requestId=user.id
 internal.drive=async()=>undefined
 // deliver is the real helper completion entry point and takes no request reference from its producer.
 await runner.deliver('A different earlier helper finished its own job','main')
 expect(internal.line('main').requestId).toBe('')
})
it('stamping keeps the recipient evidence needed to approve a valid nested-address send',()=>{
 const request={id:'stored-user',at:1795605660000,text:'Send the update to ben@example.org'}
 const meta={request,...stampCard({kind:'approval',asker:'helper',summary:'Send update',request,origin:{tool:'webapp_run',input:{tool:'send_email',args:{to:[{emailAddress:{address:'ben@example.org'}}],body:'Requested update'}}},actsForMe:true,now:1795605660000})}
 expect(meta.lane).toBe('agent')
 expect(verdictOfRow({kind:'approval',meta:JSON.stringify(meta)}).lane).toBe('agent')
})
it.each(['ben@example.orgévil.com','ében@example.org'])('never authorizes an address found only inside the different Unicode mailbox %s',named=>{
 expect(classifyCard({kind:'approval',asker:'helper',summary:'Send update',request:{id:'stored-user',at:1795605660000,text:`Send the update to ${named}`},origin:{tool:'webapp_run',input:{tool:'send_email',args:{to:'ben@example.org',body:'Report'}}}}).lane).toBe('him')
})

it('bounded stamped input never silently drops extra recipients', () => {
 const request = {id:'stored-user',at:1795605660000,text:'Send the update to ben@example.org'}
 const meta = {request,...stampCard({kind:'approval',asker:'helper',summary:'Send update',request,origin:{tool:'apps_run',input:{slug:'GMAIL_SEND_EMAIL',arguments:{to:[...Array(20).fill('ben@example.org'),'unrequested@example.org']}}},actsForMe:true,now:1795605660000})}
 expect(verdictOfRow({kind:'approval',meta:JSON.stringify(meta)}).lane).toBe('him')
})
