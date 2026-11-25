import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Tool } from '@agent/core'
import { shellTools } from '../src/main/tools/shell'
import { codeTools } from '../src/main/tools/code'
import { planToolContext } from '../src/main/runtime/cli-host'
import { startToolServer } from '../src/main/runtime/mcp-server'
import { testContext } from './support'
afterEach(()=>vi.restoreAllMocks())
it('plan command fallback supports long timeouts, large output and the original cwd/home',async()=>{
 const ctx=planToolContext({cli:'codex',context:testContext(),folder:process.cwd()},{...DEFAULT_SETTINGS,prGateEnabled:true})
 const timers=vi.spyOn(globalThis,'setTimeout')
 const shell=shellTools({settings:{get:()=>({shell:'always'})}})[0]!
 const result=await shell.run({command:'printf "%s\\n" "$PWD"; printf "%060000d" 1',timeoutSec:1201},ctx)
 expect(result).toContain(process.cwd());expect(result.length).toBeGreaterThan(60_000)
 expect(result).not.toContain('cut,')
 expect(timers.mock.calls.some(call=>call[1]===1201_000)).toBe(true)
 await shell.run({command:'printf default-timeout'},ctx)
 expect(timers.mock.calls.some(call=>call[1]===60_000)).toBe(true)
 const code=codeTools({settings:{get:()=>({shell:'always'})}})[0]!
 const text=await code.run({language:'javascript',code:'console.log(process.cwd());console.log(process.env.HOME);console.log("x".repeat(60000))'},ctx)
 expect(text).toContain(process.cwd());expect(text).toContain(process.env['HOME'])
 expect(text.length).toBeGreaterThan(60_000)
 expect(timers.mock.calls.some(call=>call[1]===3600_000)).toBe(true)
},30_000)
it('MCP retains long tool output and refuses a direct private gate call',async()=>{
 const server=await startToolServer()
 const context=planToolContext({cli:'codex',context:testContext()},{...DEFAULT_SETTINGS,prGateEnabled:true})
 const tool:Tool={spec:{name:'shell_run',description:'Test',schema:{}},run:async()=> 'x'.repeat(120_000)}
 const token=server.open({tools:[tool,...['apps_run','webapp_run'].map(name=>({...tool,spec:{...tool.spec,name}}))],context})
 try{
  const call=async(name:string)=> (await fetch(server.url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{}}})})).json()
  const result=await call('shell_run')
  expect(result.result.content[0].text).toHaveLength(120_000)
  for(const name of ['apps_run','webapp_run']){
   const clipped=await call(name)
   expect(clipped.result.content[0].text).toContain('(cut, 120000 chars total)')
   expect(clipped.result.content[0].text.length).toBeLessThan(24_100)
  }
  const refused=await call('pr_gate_check')
  expect(refused.result.isError).toBe(true)
  expect(refused.result.content[0].text).toContain('Unknown tool')
 }finally{await server.close()}
})
