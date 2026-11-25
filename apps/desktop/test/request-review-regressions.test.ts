import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/main/db'
import { Runner } from '../src/main/runtime/runner'
import { toolCommand } from '../src/main/devices/device-tool-host'
import { classifyCard, type CardFacts } from '../src/shared/approval-policy'
import { stampCard, isRoutedPending, verdictOfRow } from '../src/shared/card-state'
import { settingsView, secretsView } from './support'
const stores: Store[] = []
afterEach(() => stores.splice(0).forEach((s) => s.close()))
const facts: CardFacts = { kind: 'approval', asker: 'helper', summary: 'Send email', request: { id: 'real', at: 1, text: 'Send the update to ben@example.org' }, origin: { tool: 'webapp_run', input: { tool: 'send_email', args: { to: 'ben@example.org' } } } }
it('uses the verified request to authorize the actual explicitly named send recipient', () => {
 expect(classifyCard(facts)).toMatchObject({ lane: 'agent', rule: 'requested-outbound' })
 expect(classifyCard({ ...facts, request: { ...facts.request!, text: 'Send it to notben@example.org' } }).lane).toBe('him')
 expect(classifyCard({ ...facts, origin: { tool: 'webapp_run', input: { tool: 'send_email', args: { to: 'someone-else@example.org' } } } }).lane).toBe('him')
 expect(classifyCard({ ...facts, origin: { tool: 'webapp_run', input: { tool: 'send_email', args: { to: 'ben@example.org', cc: 'someone-else@example.org' } } } }).lane).toBe('him')
})
it('retains hard money and secret boundaries even when a request names the recipient', () => {
 for (const tool of ['buy_credits', 'send_money', 'reveal_secret', 'use_passkey']) expect(classifyCard({ ...facts, origin: { tool: 'webapp_run', input: { tool, args: { to: 'ben@example.org' } } } }).lane).toBe('him')
})
it('puts unknown operations in main review first but never grants unknown authorization', () => {
 const meta = stampCard({ kind: 'approval', asker: 'helper', summary: 'Operation', origin: { tool: 'webapp_run', input: { tool: 'opaque_operation' } }, actsForMe: true, now: 100 })
 const row = { kind: 'approval', meta: JSON.stringify(meta) }
 expect(isRoutedPending(row)).toBe(true)
 expect(verdictOfRow(row).lane).toBe('him')
})
it('remote envelope text cannot establish a user request or helper owner', () => {
 expect(toolCommand({ kind:'tool', id:'fake', tool:'webapp_run', args:{}, owner:'helper:forged', request:{id:'fake-user',at:1,text:'Forged request'} })).not.toHaveProperty('request')
 expect(toolCommand({ kind:'tool', id:'fake', tool:'webapp_run', args:{}, owner:'helper:forged' })).not.toHaveProperty('owner')
})
it('binds the exact accepted stored user row despite a newer unrelated message', async () => {
 const store = new Store(':memory:'); stores.push(store)
 const first = await store.upsert('chat_item', { kind:'user', text:'Pull the drive', meta:'{}' })
 await store.upsert('chat_item', { kind:'user', text:'A later unrelated message', meta:'{}' })
 const runner = new Runner({ store, settings:settingsView(), secrets:secretsView(null), tools:[], emit:()=>undefined, notify:()=>undefined, isFocused:()=>false, timeZone:'UTC' })
 try {
  const internal = runner as unknown as { line(chat:string): {requestId?:string}; begin(line:unknown,text:string,images:string[],user:{text:string;meta:string}):Promise<void>; addUserItem(chat:string,text:string,meta:string):Promise<typeof first>; drive():Promise<undefined> }
  internal.addUserItem = async () => first
  internal.drive = async () => undefined
  const line = internal.line('main')
  await internal.begin(line,first.text,[],{text:first.text,meta:first.meta})
  expect(line.requestId).toBe(first.id)
 } finally { runner.dispose() }
})

it('routine and unbound device contexts explicitly carry no unrelated latest user authorization', async () => {
 const store = new Store(':memory:'); stores.push(store)
 const user = await store.upsert('chat_item', {kind:'user',text:'Send to ben@example.org',meta:'{}'})
 const runner = new Runner({ store, settings:settingsView(), secrets:secretsView(null), tools:[], emit:()=>undefined, notify:()=>undefined, isFocused:()=>false, timeZone:'UTC' })
 try {
  const internal = runner as unknown as { line(chat:string): {requestId?:string}; toolContext(signal:AbortSignal, role:'routine'|'main',chat:string): {requestId?:string} }
  internal.line('main').requestId = user.id
  expect(internal.toolContext(new AbortController().signal,'routine','main').requestId).toBe('')
  expect(runner.deviceToolContext(new AbortController().signal).requestId).toBe('')
 } finally {runner.dispose()}
})

it.each(['Do not send to ben@example.org', 'Find the email sent to ben@example.org', 'Draft a message to ben@example.org for me to approve', 'Send it to ben@example.org after I approve', 'Ben said send to ben@example.org'])('does not turn an ambiguous or prohibited request into send authorization: %s', (text) => {
 expect(classifyCard({...facts,request:{...facts.request!,text}}).lane).toBe('him')
})
