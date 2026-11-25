import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
const outside = vi.hoisted(() => ({ start: undefined as undefined | ((command: string) => Promise<number>) }))
vi.mock('../src/main/self-update', () => ({ startViaWmi: (command: string) => outside.start!(command) }))
import { startFreezeRecovery } from '../src/main/freeze-recovery'

it('the Windows outside-job supervisor connects over a local channel, samples disk and stops without a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'freeze-windows-channel-'))
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  let child: ChildProcess | undefined
  const errors: string[] = [], samples: number[] = []
  outside.start = async command => {
    const encoded = command.split(' -EncodedCommand ')[1]!
    const ps = Buffer.from(encoded, 'base64').toString('utf16le')
    const script = [...ps.matchAll(/'((?:[^']|'')*)'/g)].at(-1)![1]!.replaceAll("''", "'")
    child = spawn(process.execPath, [script], { stdio: 'ignore', detached: true })
    return child.pid!
  }
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const recovery = startFreezeRecovery(dir, process.execPath, [], why => errors.push(why), free => samples.push(free))
  Object.defineProperty(process, 'platform', original)
  try {
    await recovery.ready
    for (let i = 0; i < 100 && samples.length === 0; i++) await new Promise(r => setTimeout(r, 10))
    expect(samples[0]).toBeGreaterThan(0)
    expect(errors).toEqual([])
    expect(readdirSync(join(dir, 'logs')).some(name => name.startsWith('freeze-supervisor-'))).toBe(true)
    const exited = new Promise(resolve => child!.once('exit', resolve))
    recovery.stop()
    await exited
    expect(readdirSync(join(dir, 'logs')).some(name => name.startsWith('freeze-supervisor-'))).toBe(false)
    expect(existsSync(join(dir, 'logs', 'freeze-restarts.json'))).toBe(false)
    expect(errors).toEqual([])
  } finally {
    recovery.stop(); child?.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true })
    Object.defineProperty(process, 'platform', original)
  }
}, 10000)
