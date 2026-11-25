import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { recoveryWorkerCode } from '../src/main/freeze-recovery'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
it('detects a genuinely hung process, writes diagnostics before recovery, and caps restart loops across starts', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'freeze-proof-')); dirs.push(dir)
 const log = join(dir, 'diagnostics.log'), state = join(dir, 'state.json'), marker = join(dir, 'unavailable.json'), proof = join(dir, 'restart.txt')
 const victim = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' })
 const run = async () => {
   const child = spawn(process.execPath, ['-e', recoveryWorkerCode({ parentPid: victim.pid!, executable: process.execPath, args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(proof)}, 'restart\\n')`], log, state, marker, timeoutMs: 120, intervalMs: 20, startupMs: 0, maxRestarts: 1, windowMs: 60_000, restartDelayMs: 10 })], { stdio: ['ignore','ignore','pipe','ipc'] })
   child.send({ type: 'beat', memory: { rss: 123 } })
   await new Promise<void>((resolve, reject) => { child.once('exit', code => code === 0 ? resolve() : reject(new Error('watchdog exit '+code))); child.once('error', reject) })
 }
 try {
  await run()
  expect(readFileSync(log, 'utf8')).toContain('Main process frozen')
  expect(readFileSync(log, 'utf8')).toContain('123')
  expect(readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)).length).toBeGreaterThan(1)
  expect(JSON.parse(readFileSync(marker,'utf8')).parentPid).toBe(victim.pid)
  await new Promise(r=>setTimeout(r,100))
  expect(readFileSync(proof,'utf8')).toBe('restart\n')
  await run()
  expect(readFileSync(log,'utf8')).toContain('Restart cap reached')
  expect(readFileSync(proof,'utf8')).toBe('restart\n')
 } finally { victim.kill('SIGKILL') }
}, 10_000)
it('a clean stop never restarts or records a failure', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'freeze-stop-')); dirs.push(dir)
 const state = join(dir, 'state.json'); writeFileSync(state, '[]')
 const child = spawn(process.execPath, ['-e', recoveryWorkerCode({ parentPid: process.pid, executable: process.execPath, args: [], log: join(dir,'log'), state, marker: join(dir,'marker'), timeoutMs: 100, intervalMs: 20, startupMs: 0 })], { stdio: ['ignore','ignore','pipe','ipc'] })
 child.send({type:'stop'})
 await new Promise(r=>child.once('exit',r))
 expect(readFileSync(state,'utf8')).toBe('[]')
})

it('holds recovery while disk is critical, then clears its unavailable flag when the same main becomes healthy again', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'freeze-disk-')); dirs.push(dir)
 const fixture = join(dir, 'disk.json'), marker = join(dir, 'marker'), state = join(dir, 'state')
 const sample = (free: number) => writeFileSync(fixture, JSON.stringify({bavail: free * 1073741824, bsize: 1, blocks: 1000 * 1073741824}))
 sample(1)
 const victim = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'})
 const code = `require('node:fs').promises.statfs = async () => JSON.parse(require('node:fs').readFileSync(${JSON.stringify(fixture)}, 'utf8'));\n` + recoveryWorkerCode({parentPid:victim.pid!,executable:process.execPath,args:[],log:join(dir,'log'),state,marker,dataPath:dir,diskIntervalMs:20,timeoutMs:1000,intervalMs:20,startupMs:0})
 const child = spawn(process.execPath, ['-e', code], {stdio:['ignore','ignore','pipe','ipc']})
 let beat: ReturnType<typeof setInterval> | undefined
 const until = async (done:()=>boolean) => { for(let i=0;i<300;i++){if(done()) return; await new Promise(r=>setTimeout(r,10))}; throw new Error('watchdog condition timed out') }
 try {
  child.send({type:'beat'})
  await until(()=>existsSync(marker))
  expect(()=>process.kill(victim.pid!,0)).not.toThrow()
  expect(existsSync(state)).toBe(false)
  const heard = new Promise<void>(r=>{child.on('message',(m: {type?:string;id?:string})=>{if(m.type==='beatAck'&&m.id==='thawed') r()})})
  child.send({type:'beat',ack:'thawed'})
  await heard
  beat=setInterval(()=>{if(child.connected) child.send({type:'beat'})},20)
  sample(21)
  await until(()=>!existsSync(marker))
  expect(readFileSync(join(dir,'log'),'utf8')).toContain('responsive again after disk recovery')
  expect(existsSync(state)).toBe(false)
  const exited = new Promise(r=>child.once('exit',r)); child.send({type:'stop'}); await exited
 } finally {if(beat) clearInterval(beat); child.kill('SIGKILL'); victim.kill('SIGKILL')}
},10_000)
