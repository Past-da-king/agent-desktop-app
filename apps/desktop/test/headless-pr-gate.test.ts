import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { startHeadlessRuntime, type HeadlessRuntime } from '../src/headless/runtime'
import { ATTESTATION_FIELDS } from '../src/main/runtime/pr-gate'
import { testContext, toolNamed } from './support'

let runtime: HeadlessRuntime | null = null
let dir = ''
afterEach(async()=>{
  await runtime?.stop(0);runtime=null
  vi.unstubAllEnvs()
  if(dir) rmSync(dir,{recursive:true,force:true})
})
it('headless main and worker-native gate paths hold, attest, pass once and allow draft with a fake gh',async()=>{
  dir=mkdtempSync(join(tmpdir(),'pr-gate-node-'))
  const bin=join(dir,'bin');mkdirSync(bin)
  writeFileSync(join(bin,'gh'),'#!/bin/sh\nprintf "FAKE_GH_EXECUTED %s\\n" "$*"\n',{mode:0o755})
  vi.stubEnv('PATH',bin+':'+process.env['PATH'])
  runtime=await startHeadlessRuntime({dataDir:join(dir,'data'),appDir:process.cwd(),version:'9.9.9',quiet:true,chromium:null})
  runtime.settings.save({prGateEnabled:true,shell:'always'})
  const ctx=testContext({owner:'helper:node-author',agentLabel:'node-author',chat:'proof-chat'})
  const command={command:bin+'/gh pr create --title Example --body Example'}
  const shell=toolNamed(runtime.mainTools,'shell_run')
  const held=await shell.run(command,ctx)
  expect(held).toContain('NOT RUN')
  expect(held).not.toContain('FAKE_GH_EXECUTED')
  const id=held.match(/Gate id: ([a-f0-9-]+)/)![1]!
  const attestation=Object.fromEntries(ATTESTATION_FIELDS.map(k=>[k,'Specific evidence verified in /tmp/node-proof.md: '+k]))
  attestation.reviewerAgentId='helper:independent-node-reviewer'
  expect(await toolNamed(runtime.mainTools,'pr_gate_attest').run({gateId:id,attestation},ctx)).toContain('recorded')
  expect(await shell.run(command,ctx)).toContain('FAKE_GH_EXECUTED')
  expect(await shell.run(command,ctx)).toContain('NOT RUN')
  expect(await shell.run({command:bin+'/gh pr create --draft --title Example --body Example'},ctx)).toContain('FAKE_GH_EXECUTED')
  expect(await toolNamed(runtime.mainTools,'pr_gate_check').run({tool:'Bash',input:command},ctx)).toContain('NOT RUN')
  expect((await runtime.store.list('chat_item')).some(r=>r.kind==='pr_gate'&&r.text==='passed once')).toBe(true)
},60_000)
