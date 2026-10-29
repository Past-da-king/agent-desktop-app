/**
 * The auto-commit hook every run goes through (helpers and chat turns; Settings > Git). A run `begin`s with its
 * project folder; each tool call it makes is `touch`ed, so a repo it works in outside that folder (a file path or a
 * shell's cwd) is looked at the first time it is used; at the end the run's changes in each repo are committed and
 * pushed (git/autocommit.ts) and one line comes back for whoever started the run. Off unless the person switches it on.
 *
 * Work in one repo is done one run at a time (a queue per repo), so two runs ending together never interleave git.
 * Every outcome is logged (kept on this device, newest first) for Settings > Git.
 */
import { dirname, isAbsolute } from 'node:path'
import { statSync } from 'node:fs'

import { commitRun, repoRootOf, snapshot, type AutoCommitResult, type RepoSnapshot } from './autocommit'
import { defaultGitExec, type GitExec } from './git-exec'
import type { VaultHashes } from './secret-scan'

export interface GitSettings {
  gitAutoCommit: boolean
  gitAutoPush: boolean
  gitMaxFileMb: number
  gitExclude: string
}

export interface GitLogEntry {
  at: number
  run: string
  title: string
  repo: string
  branch: string
  status: AutoCommitResult['status']
  commit?: string
  files: number
  pushed: boolean
  note: string
  reason: string
}

export interface KeyValue {
  get(key: string): string | null
  set(key: string, value: string): void
}

export interface RunGitHookDeps {
  settings: () => GitSettings
  kv: KeyValue
  vault?: () => VaultHashes | undefined
  exec?: GitExec
  now?: () => number
  log?: (line: string) => void
}

const LOG_KEY = 'git.autocommit.log'
/** Full hashes of the commits the auto-commit made, newest first (an unpushed one of its own never blocks a push). */
const OWN_KEY = 'git.autocommit.own'
const LOG_MAX = 200
/** How long a run waits for its starting look before it starts anyway. */
export const BEGIN_WAIT_MS = 5000

/** Input fields of a tool call that name a file or a folder it works in. */
const PATH_FIELDS = ['file_path', 'filePath', 'path', 'notebook_path', 'cwd', 'folder', 'dir', 'directory', 'workdir', 'working_directory', 'target', 'destination', 'dest', 'to']

/** Absolute paths a tool call names. */
export function pathsOfCall(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return []
  const record = input as Record<string, unknown>
  const out: string[] = []
  const take = (value: unknown): void => {
    if (typeof value === 'string' && value.length < 1000 && isAbsolute(value.trim())) out.push(value.trim())
  }
  for (const field of PATH_FIELDS) take(record[field])
  for (const field of ['paths', 'files']) {
    const list = record[field]
    if (Array.isArray(list)) for (const item of list.slice(0, 20)) take(item)
  }
  return out
}

function folderOf(path: string): string {
  try {
    return statSync(path).isDirectory() ? path : dirname(path)
  } catch {
    return dirname(path)
  }
}

interface RunState {
  /** Repo root -> its look at the start (null while it is being taken, or when it failed). */
  repos: Map<string, Promise<RepoSnapshot | null>>
  /** Folders already resolved (folder -> repo root or ''). */
  folders: Map<string, Promise<string>>
}

export class RunGitHook {
  private readonly deps: RunGitHookDeps
  private readonly exec: GitExec
  private readonly runs = new Map<string, RunState>()
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(deps: RunGitHookDeps) {
    this.deps = deps
    this.exec = deps.exec ?? defaultGitExec
  }

  enabled(): boolean {
    return this.deps.settings().gitAutoCommit === true
  }

  /** A run starts working, in this folder ('' for none). Resolves once the folder's repo was looked at (or 5 s). */
  async begin(key: string, folder: string): Promise<void> {
    if (!this.enabled()) return
    const state: RunState = { repos: new Map(), folders: new Map() }
    this.runs.set(key, state)
    if (folder.trim() === '') return
    const look = this.lookAt(state, folder.trim())
    await Promise.race([look, new Promise((resolve) => setTimeout(resolve, BEGIN_WAIT_MS))])
  }

  /** A tool call of the run: a repo it names is looked at the first time (before the call changes it, if in time). */
  touch(key: string, input: unknown): Promise<void> {
    const state = this.runs.get(key)
    if (state === undefined) return Promise.resolve()
    const paths = pathsOfCall(input)
    if (paths.length === 0) return Promise.resolve()
    const looks = Promise.all(paths.map((path) => this.lookAt(state, folderOf(path)))).then(() => undefined)
    return Promise.race([looks, new Promise<void>((resolve) => setTimeout(resolve, BEGIN_WAIT_MS))])
  }

  /** Forget a run without committing (it was handed on, or the app is closing). */
  drop(key: string): void {
    this.runs.delete(key)
  }

  /**
   * The run ended: commit and push its work in every repo it worked in. Returns one line per repo worth telling
   * whoever started the run ('' when there is nothing to say).
   */
  async end(key: string, title: string): Promise<{ note: string; problem: boolean; results: AutoCommitResult[] }> {
    const state = this.runs.get(key)
    this.runs.delete(key)
    if (state === undefined || !this.enabled()) return { note: '', problem: false, results: [] }
    const settings = this.deps.settings()
    const vault = this.deps.vault?.()
    const looks = (await Promise.all([...state.repos.values()])).filter((look): look is RepoSnapshot => look !== null)
    const results: AutoCommitResult[] = []
    for (const look of looks) {
      const result = await this.inQueue(look.root, () =>
        commitRun(look, title, {
          push: settings.gitAutoPush !== false,
          maxFileBytes: Math.max(1, settings.gitMaxFileMb || 5) * 1024 * 1024,
          exclude: settings.gitExclude.split(/[\n,]+/).map((part) => part.trim()).filter((part) => part !== ''),
          exec: this.exec,
          ownCommit: (sha) => this.own().includes(sha),
          ...(vault === undefined ? {} : { vault }),
        }).catch(
          (error: unknown): AutoCommitResult => ({
            root: look.root,
            branch: '',
            status: 'failed',
            files: [],
            pushed: false,
            secrets: [],
            mixed: [],
            junk: [],
            tooBig: [],
            note: `Git: auto-commit failed in ${look.root}: ${error instanceof Error ? error.message : String(error)}.`,
            reason: 'error',
          }),
        ),
      )
      results.push(result)
      if (result.commitSha !== undefined) this.remember(result.commitSha)
      if (result.status !== 'nothing') this.record(key, title, result)
    }
    const problem = results.some((r) => r.status === 'skipped' || r.status === 'blocked' || r.status === 'failed' || r.secrets.length > 0 || r.mixed.length > 0 || (r.reason !== '' && !r.pushed))
    return { note: results.map((r) => r.note).filter((n) => n !== '').join('\n'), problem, results }
  }

  /** What was committed and pushed, newest first. */
  log(limit = 50): GitLogEntry[] {
    try {
      const parsed: unknown = JSON.parse(this.deps.kv.get(LOG_KEY) ?? '[]')
      return Array.isArray(parsed) ? (parsed as GitLogEntry[]).slice(0, limit) : []
    } catch {
      return []
    }
  }

  private own(): string[] {
    try {
      const parsed: unknown = JSON.parse(this.deps.kv.get(OWN_KEY) ?? '[]')
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    } catch {
      return []
    }
  }

  private remember(sha: string): void {
    try {
      this.deps.kv.set(OWN_KEY, JSON.stringify([sha, ...this.own().filter((each) => each !== sha)].slice(0, 500)))
    } catch {
      // best effort
    }
  }

  private record(run: string, title: string, result: AutoCommitResult): void {
    const entry: GitLogEntry = {
      at: (this.deps.now ?? Date.now)(),
      run,
      title: title.slice(0, 120),
      repo: result.root,
      branch: result.branch,
      status: result.status,
      ...(result.commit === undefined ? {} : { commit: result.commit }),
      files: result.files.length,
      pushed: result.pushed,
      note: result.note,
      reason: result.reason,
    }
    try {
      this.deps.kv.set(LOG_KEY, JSON.stringify([entry, ...this.log(LOG_MAX)].slice(0, LOG_MAX)))
    } catch {
      // The log is a convenience; a failed write never stops the run's end.
    }
    this.deps.log?.(`git auto-commit ${result.status} in ${result.root}${result.commit === undefined ? '' : ` ${result.commit}`}${result.reason === '' ? '' : `: ${result.reason}`}`)
  }

  private lookAt(state: RunState, folder: string): Promise<void> {
    let root = state.folders.get(folder)
    if (root === undefined) {
      root = snapshotRoot(folder, this.exec)
      state.folders.set(folder, root)
    }
    return root.then((found) => {
      if (found === '' || state.repos.has(found)) return
      const look = this.inQueue(found, () => snapshot(found, this.exec).catch(() => null))
      state.repos.set(found, look)
      return look.then(() => undefined)
    })
  }

  private inQueue<T>(root: string, work: () => Promise<T>): Promise<T> {
    const key = root.toLowerCase()
    const before = this.queues.get(key) ?? Promise.resolve()
    const next = before.then(work, work)
    const tail = next.catch(() => undefined)
    this.queues.set(key, tail)
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
    return next
  }
}

async function snapshotRoot(folder: string, exec: GitExec): Promise<string> {
  return (await repoRootOf(folder, exec).catch(() => null)) ?? ''
}
