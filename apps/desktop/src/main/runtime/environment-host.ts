import { ownRunTree } from './run-tree'
import { childPipeFailure, registerChildPipeCleanup } from './safe-pipe'
/**
 * The real pieces behind `environment.ts`: node:fs, node:os and execFile. Kept apart so the scan
 * itself stays injectable and testable on any platform.
 */
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import { arch, hostname, release } from 'node:os'

import { killProcessTree } from '../tools/shell'
import { spawnResolved } from './spawn'

import {
  createEnvironment,
  type EnvironmentFs,
  type EnvironmentService,
  type ExecFn,
  type ExecResult,
} from './environment'

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return -1
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function listFolder(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

export const fileProbe: EnvironmentFs = {
  exists: existsSync,
  isDirectory,
  size: sizeOf,
  list: listFolder,
  isExecutable,
}

/** Run only `--version`, with a hard timeout, through the right launcher for the file type. */
export const execVersion: ExecFn = (file, args, options) =>
  new Promise<ExecResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnResolved(file, args, {
        platform: process.platform,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }

    const tree = ownRunTree(child, process.platform, () => killProcessTree(child.pid, process.platform))
    registerChildPipeCleanup(child, tree.kill)
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error: Error | null, release = true): void => {
      if (settled) return
      settled = true
      if (release) tree.release()
      clearTimeout(timer)
      if (error !== null && stdout.trim() === '' && stderr.trim() === '') reject(error)
      else resolve({ stdout, stderr })
    }
    const timer = setTimeout(() => {
      tree.kill()
      // Cleanup was attempted. If the tree is still not ours to release (Windows leader already gone, EPERM),
      // the probe still answers at its deadline and the close-time cleanup keeps the latch.
      finish(new Error('version check timed out'), tree.settled)
    }, options.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    let pipeError: Error | null = null
    child.once('error', (error) => {
      if (childPipeFailure(child) === undefined) finish(error)
      else pipeError = error
    })
    tree.onSettled(() => { clearTimeout(timer); if (tree.closed) finish(pipeError) })
    child.once('close', () => { if (tree.settled) finish(pipeError) })
  })

export function hostEnvironment(): EnvironmentService {
  return createEnvironment({
    platform: process.platform,
    env: process.env,
    release: release(),
    arch: arch(),
    hostname: hostname(),
    fs: fileProbe,
    exec: execVersion,
    now: Date.now,
  })
}
