import { registerChildPipeCleanup } from '../runtime/safe-pipe'
/**
 * Starting a worker process for real. Node workers run on the app's own binary (ELECTRON_RUN_AS_NODE), so no
 * installed Node is assumed. Python, PowerShell and plain commands are found the same way shell_run finds them.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { basename, join } from 'node:path'

import type { WorkerManifest } from '@agent/core'

import { fileProbe } from '../runtime/environment-host'
import { spawnResolved } from '../runtime/spawn'
import { killProcessTree } from '../tools/shell'
import type { ChildLike, WorkerSpawn } from './supervisor'

export const spawnWorker: WorkerSpawn = ({ manifest, dir, env }) => {
  const entry = join(dir, manifest.entry)
  const owned = (child: ChildProcess): ChildLike => {
    registerChildPipeCleanup(child, () => {
      if (process.platform !== 'win32' || (child.exitCode == null && child.signalCode == null)) killTree(child.pid)
    })
    return child as unknown as ChildLike
  }
  const options = { detached: process.platform !== 'win32', cwd: dir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] as Array<'pipe'> }
  const resolve = { platform: process.platform, env, fs: fileProbe }
  switch (manifest.runtime) {
    case 'node':
      return owned(spawn(process.execPath, [entry, ...manifest.args], {
        ...options,
        windowsHide: true,
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        shell: false,
      }))
    case 'python':
      return owned(spawnResolved(process.platform === 'win32' ? 'python' : 'python3', ['-u', entry, ...manifest.args], {
        ...options,
        env: { ...env, PYTHONUNBUFFERED: '1' },
        resolve,
      }))
    case 'powershell':
      return owned(spawnResolved(process.platform === 'win32' ? 'powershell' : 'pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', entry, ...manifest.args], {
        ...options,
        resolve,
      }))
    case 'command':
      return owned(spawnResolved(manifest.entry, manifest.args, { ...options, resolve }))
  }
}

export function killTree(pid: number | undefined): void {
  killProcessTree(pid, process.platform)
}

/**
 * A worker left running by an app that crashed: only killed when the pid still belongs to the app's own program
 * (node workers run on it), so a reused pid of something else is never touched.
 */
export function killLeftover(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8', timeout: 5000 })
      if (!out.toLowerCase().includes(`"${basename(process.execPath).toLowerCase()}"`)) return false
    } else {
      // Without a cheap, reliable way to tell whose process it is, leave it alone.
      return false
    }
    killProcessTree(pid, process.platform)
    return true
  } catch {
    return false
  }
}
