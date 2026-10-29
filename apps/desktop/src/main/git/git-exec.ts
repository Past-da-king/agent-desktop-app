/**
 * Running git for the auto-commit (git/autocommit.ts). Never interactive: no prompts for passwords, no editor, no
 * pager. A folder on a WSL share (\\wsl.localhost\<distro>\... or \\wsl$\<distro>\...) runs WSL's own git inside that
 * distro, so its file modes, hooks and credentials are the ones the repo was made with.
 */
import { spawn } from 'node:child_process'

export interface GitResult {
  code: number
  out: string
  err: string
}

/** Runs git in a folder. `input` goes to its stdin. */
export type GitExec = (cwd: string, args: string[], options?: { input?: string; timeoutMs?: number }) => Promise<GitResult>

/** A WSL share path as its distro and Linux path, or null. */
export function wslTarget(path: string): { distro: string; path: string } | null {
  const m = /^(?:\\\\|\/\/)(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(.*)$/i.exec(path)
  if (m === null) return null
  const rest = (m[2] ?? '').replace(/\\/g, '/')
  return { distro: m[1] ?? '', path: rest === '' ? '/' : rest }
}

/** A path git printed (Linux inside WSL) as a path this computer opens. */
export function localPathOf(gitPath: string, cwd: string): string {
  const wsl = wslTarget(cwd)
  const clean = gitPath.trim()
  if (wsl === null) return clean
  const prefix = /^(\\\\|\/\/)(wsl\.localhost|wsl\$)[\\/][^\\/]+/i.exec(cwd)?.[0] ?? ''
  return `${prefix}${clean.replace(/\//g, '\\')}`
}

const QUIET_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GIT_EDITOR: 'true',
  GIT_PAGER: 'cat',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
  LC_ALL: 'C',
}

export const defaultGitExec: GitExec = (cwd, args, options = {}) =>
  new Promise((resolve) => {
    const wsl = process.platform === 'win32' ? wslTarget(cwd) : null
    const gitArgs = ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args]
    const env: Record<string, string | undefined> = { ...process.env, ...QUIET_ENV }
    if (wsl !== null) env['WSLENV'] = [process.env['WSLENV'] ?? '', 'GIT_TERMINAL_PROMPT/u', 'GCM_INTERACTIVE/u', 'GIT_EDITOR/u', 'GIT_PAGER/u', 'GIT_SSH_COMMAND/u', 'LC_ALL/u'].filter((part) => part !== '').join(':')
    const child =
      wsl === null
        ? spawn('git', gitArgs, { cwd, env, windowsHide: true })
        : spawn('wsl.exe', ['-d', wsl.distro, '--cd', wsl.path, '--exec', 'git', ...gitArgs], { env, windowsHide: true })
    let out = ''
    let err = ''
    let done = false
    const finish = (code: number): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, out, err })
    }
    const timer = setTimeout(() => {
      err += '\ngit timed out'
      child.kill()
      finish(124)
    }, options.timeoutMs ?? 60_000)
    child.stdout.on('data', (chunk: Buffer) => {
      if (out.length < 8_000_000) out += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.length < 200_000) err += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      err += String(error.message)
      finish(127)
    })
    child.on('close', (code) => finish(code ?? 1))
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
