import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@agent/core'
import { Store } from '../src/main/db'
import { buildWorkerToolset } from '../src/main/runtime/toolset'
import { CliHost, type CliTurnRequest } from '../src/main/runtime/cli-host'
import type { CliTurn } from '../src/main/runtime/cli-agent'
import { testContext } from './support'
const captured=vi.hoisted(()=>({turn:null as CliTurn|null}))
vi.mock('../src/main/runtime/cli-agent',async original=>{
 const actual=await original<typeof import('../src/main/runtime/cli-agent')>()
 return {...actual,runCliTurn:vi.fn(async(turn:CliTurn)=>{captured.turn=turn;return {text:'done',sessionId:null}})}
})
const cleanup:Array<()=>Promise<unknown>|unknown>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();captured.turn=null})
it('CliHost invokes the private native gate and keeps the Codex launch unrestricted',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pr-gate-cli-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}))
 const store=new Store(':memory:');cleanup.push(()=>store.close())
 const settings={...DEFAULT_SETTINGS,shell:'always' as const,prGateEnabled:true}
 const host=new CliHost(dir,()=>settings,process.cwd());cleanup.push(()=>host.close())
 const tools=buildWorkerToolset({store,settings:{get:()=>settings}})
 const context=testContext({owner:'helper:cli-author',agentLabel:'cli-author'})
 const request:CliTurnRequest={cli:'claude',thread:'helper:cli-author',tools,system:'Test',prompt:'Test',context,signal:context.signal,onEvent:async()=>undefined,onCall:async()=>undefined,onResult:async()=>undefined}
 await host.turn(request)
 const held=await captured.turn!.permission!('Bash',{command:'gh pr ready 3'})
 expect(held.allow).toBe(false)
 if(!held.allow)expect(held.message).toContain('NOT RUN')
 expect(captured.turn!.access).toBe('free')
 await host.turn({...request,cli:'codex'})
 expect(captured.turn!.access).toBe('free')
 expect(captured.turn!.appCommandsOnly).toBe(true)
 settings.prGateEnabled=false
 await host.turn(request)
 expect(await captured.turn!.permission!('Bash',{command:'gh pr ready 3'})).toEqual({allow:true})
},30_000)
