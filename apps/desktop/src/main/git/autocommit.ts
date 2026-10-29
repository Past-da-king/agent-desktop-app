/**
 * Auto-commit and push after a run (Settings > Git). A run's work in a git repo is committed as "WIP: <run title>" on
 * the branch the repo is on, then pushed, so finished work is never left only on this computer.
 *
 * What counts as the run's work: the repo is looked at when the run starts (`snapshot`: every changed or new file and
 * a hash of its content) and again when it ends. A file that changed between the two is the run's. A file that was
 * already changed before the run and is unchanged is the person's own: never touched. A file that was already changed
 * before AND changed again during the run holds both: it is left alone and named in the report (unsure = skip).
 *
 * Never: switch or create a branch, commit on a detached HEAD or mid-merge/rebase, pass --no-verify, force-push, push
 * after a secret was found. A repo's own .gitignore and hooks apply (a failing hook is reported, never bypassed).
 */
import { statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { defaultGitExec, localPathOf, type GitExec } from './git-exec'
import { secretByName, secretInText, type SecretHit, type VaultHashes } from './secret-scan'

export interface RepoSnapshot {
  /** The repo's top folder, as this computer opens it. */
  root: string
  /** HEAD's commit when the run started, '' for a repo with no commit yet. */
  head: string
  /** Changed or new files (relative to root) -> a signature of their content. */
  dirty: Map<string, string>
  /** Commits on the branch not on its upstream when the run started (someone else's unpushed work). */
  aheadBefore: number
  /** Those commits' hashes, so the auto-commit's own earlier commits are not mistaken for someone else's. */
  aheadShas?: string[]
  /** Too many changes to look at (thousands of untracked files): the repo is left alone. */
  tooBig?: boolean
}

export interface AutoCommitOptions {
  push: boolean
  /** Files bigger than this are never committed (bytes). */
  maxFileBytes: number
  /** More patterns to leave out ("*.mp4, renders/, tmp/**"). */
  exclude: string[]
  vault?: VaultHashes
  exec?: GitExec
  /** Was this commit made by the auto-commit itself (an earlier run's WIP left unpushed)? */
  ownCommit?: (sha: string) => boolean
}

export type AutoCommitStatus = 'committed' | 'pushed' | 'nothing' | 'skipped' | 'blocked' | 'failed'

export interface AutoCommitResult {
  root: string
  branch: string
  status: AutoCommitStatus
  /** Files committed. */
  files: string[]
  commit?: string
  /** The full hash of the commit made. */
  commitSha?: string
  pushed: boolean
  /** Files left out on purpose: secrets (by kind), changed before the run, junk, too big. */
  secrets: SecretHit[]
  mixed: string[]
  junk: string[]
  tooBig: string[]
  /** One plain line for the run's parent; '' when there is nothing worth saying. */
  note: string
  /** Why, for the log, when it did not commit or push. */
  reason: string
}

const MAX_ENTRIES = 5000

/** Folders never committed when new: build output, dependencies, caches, logs, renders. */
const JUNK_DIRS = new Set([
  'node_modules',
  'dist',
  'out',
  'release',
  '.next',
  'build',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vercel',
  '.svelte-kit',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  'logs',
  'renders',
  'tmp',
  '.tmp',
])
/** Files never committed, tracked or not: databases, logs, OS litter. */
const JUNK_FILE = /(\.(db|db-wal|db-shm|db-journal|sqlite|sqlite3|sqlite-wal|sqlite-shm|log)$)|(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i

function globToRegex(pattern: string): RegExp {
  let p = pattern.trim().replace(/\\/g, '/')
  const anchored = p.startsWith('/')
  if (anchored) p = p.slice(1)
  const dirOnly = p.endsWith('/')
  if (dirOnly) p = p.slice(0, -1)
  let re = ''
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i] ?? ''
    if (c === '*' && p[i + 1] === '*') {
      re += '.*'
      i += 1
      if (p[i + 1] === '/') i += 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]]/g, '\\$&')
  }
  const lead = anchored || p.includes('/') ? '^' : '(^|/)'
  return new RegExp(`${lead}${re}${dirOnly ? '/' : '(/|$)'}`, 'i')
}

/** Is this path left out by the extra patterns? */
export function excludedBy(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => pattern.trim() !== '' && globToRegex(pattern).test(path))
}

/** Is this new file build output or junk? Tracked files are only junk by their kind (a database, a log). */
export function isJunk(path: string, tracked: boolean): boolean {
  if (JUNK_FILE.test(path)) return true
  if (tracked) return false
  const dirs = path.split('/').slice(0, -1)
  return dirs.some((dir) => JUNK_DIRS.has(dir.toLowerCase()))
}

interface Entry {
  path: string
  xy: string
}

/** `git status --porcelain=v1 -z` as entries (a rename gives its new path). */
export function parsePorcelain(out: string): Entry[] {
  const parts = out.split('\0')
  const entries: Entry[] = []
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? ''
    if (part.length < 4) continue
    const xy = part.slice(0, 2)
    entries.push({ path: part.slice(3), xy })
    if (xy[0] === 'R' || xy[0] === 'C') i += 1
  }
  return entries
}

async function git(exec: GitExec, root: string, args: string[], input?: string, timeoutMs?: number): Promise<{ code: number; out: string; err: string }> {
  return exec(root, args, { ...(input === undefined ? {} : { input }), ...(timeoutMs === undefined ? {} : { timeoutMs }) })
}

function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !/^hint:/i.test(l))
  return (line ?? '').slice(0, 200)
}

/** The repo a folder is in, as this computer opens it; null when it is not in one. */
export async function repoRootOf(folder: string, exec: GitExec = defaultGitExec): Promise<string | null> {
  const top = await git(exec, folder, ['rev-parse', '--show-toplevel'], undefined, 20_000)
  if (top.code !== 0 || top.out.trim() === '') return null
  return localPathOf(top.out.trim(), folder)
}

async function status(exec: GitExec, root: string): Promise<Entry[] | null> {
  const st = await git(exec, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], undefined, 60_000)
  return st.code === 0 ? parsePorcelain(st.out) : null
}

/** A signature per path: the git blob hash of what is on disk, 'gone' when deleted. */
async function signatures(exec: GitExec, root: string, entries: Entry[]): Promise<Map<string, string>> {
  const sigs = new Map<string, string>()
  const present: string[] = []
  for (const entry of entries) {
    if (entry.xy.includes('D') && entry.xy !== '??') sigs.set(entry.path, `gone:${entry.xy}`)
    else present.push(entry.path)
  }
  if (present.length === 0) return sigs
  const batch = await git(exec, root, ['hash-object', '--no-filters', '--stdin-paths'], `${present.join('\n')}\n`, 60_000)
  const lines = batch.out.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (batch.code === 0 && lines.length === present.length) {
    present.forEach((path, i) => sigs.set(path, lines[i]?.trim() ?? ''))
    return sigs
  }
  // A folder (a submodule) or a file that vanished in between breaks the batch: one by one instead.
  for (const path of present) {
    const one = await git(exec, root, ['hash-object', '--no-filters', '--', path], undefined, 20_000)
    sigs.set(path, one.code === 0 ? one.out.trim() : `x:${path}`)
  }
  return sigs
}

async function branchOf(exec: GitExec, root: string): Promise<string> {
  const ref = await git(exec, root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return ref.code === 0 ? ref.out.trim() : ''
}

async function headOf(exec: GitExec, root: string): Promise<string> {
  const head = await git(exec, root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  return head.code === 0 ? head.out.trim() : ''
}

async function upstreamOf(exec: GitExec, root: string): Promise<string> {
  const up = await git(exec, root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  return up.code === 0 ? up.out.trim() : ''
}

async function aheadShasOf(exec: GitExec, root: string): Promise<string[]> {
  const list = await git(exec, root, ['rev-list', '@{u}..HEAD'])
  return list.code === 0 ? list.out.split(/\s+/).map((l) => l.trim()).filter((l) => l !== '') : []
}

async function aheadOf(exec: GitExec, root: string): Promise<number> {
  const count = await git(exec, root, ['rev-list', '--count', '@{u}..HEAD'])
  return count.code === 0 ? Number(count.out.trim()) || 0 : 0
}

/** Mid-merge, mid-rebase, mid-cherry-pick or mid-bisect: not a moment to commit. */
async function busyState(exec: GitExec, root: string): Promise<string> {
  for (const [name, what] of [
    ['MERGE_HEAD', 'a merge'],
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
  ] as const) {
    const p = await git(exec, root, ['rev-parse', '--git-path', name])
    if (p.code !== 0) continue
    const local = localPathOf(p.out.trim(), root)
    const full = /^([a-z]:|\\\\|\/)/i.test(local) ? local : join(root, local)
    try {
      statSync(full)
      return what
    } catch {
      // not there
    }
  }
  return ''
}

/** The repo as it is now, before a run works in it. Null when the folder is not in a git repo. */
export async function snapshot(folder: string, exec: GitExec = defaultGitExec): Promise<RepoSnapshot | null> {
  const root = await repoRootOf(folder, exec)
  if (root === null) return null
  const entries = await status(exec, root)
  if (entries === null) return null
  const head = await headOf(exec, root)
  const aheadShas = (await upstreamOf(exec, root)) === '' ? [] : await aheadShasOf(exec, root)
  const aheadBefore = aheadShas.length
  if (entries.length > MAX_ENTRIES) return { root, head, dirty: new Map(), aheadBefore, aheadShas, tooBig: true }
  return { root, head, dirty: await signatures(exec, root, entries), aheadBefore, aheadShas }
}

function readText(path: string, maxBytes: number): string | null {
  try {
    const size = statSync(path).size
    if (size > maxBytes) return null
    return readFileSync(path).toString('utf8')
  } catch {
    return null
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function repoName(root: string): string {
  const parts = root.split(/[\\/]/).filter((part) => part !== '')
  return parts[parts.length - 1] ?? root
}

/** The commit message: "WIP: <title>", one line, no trailers. */
export function wipMessage(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 72)
  return `WIP: ${clean === '' ? 'agent run' : clean}`
}

/**
 * Commit what the run changed since `before`, then push. Returns what happened; never throws for a git failure.
 */
export async function commitRun(before: RepoSnapshot, title: string, options: AutoCommitOptions): Promise<AutoCommitResult> {
  const exec = options.exec ?? defaultGitExec
  const root = before.root
  const name = repoName(root)
  const result: AutoCommitResult = { root, branch: '', status: 'nothing', files: [], pushed: false, secrets: [], mixed: [], junk: [], tooBig: [], note: '', reason: '' }
  const stop = (status: AutoCommitStatus, reason: string, note = ''): AutoCommitResult => {
    result.status = status
    result.reason = reason
    result.note = note
    return result
  }
  if (before.tooBig === true) return stop('skipped', `more than ${MAX_ENTRIES} changed files`, `Git: did not auto-commit in ${name}: more than ${MAX_ENTRIES} changed files, too many to tell the run's apart.`)

  const branch = await branchOf(exec, root)
  result.branch = branch
  const entries = await status(exec, root)
  if (entries === null) return stop('failed', 'git status failed', `Git: could not read ${name}'s status, nothing committed.`)
  const head = await headOf(exec, root)
  const madeCommits = head !== before.head && head !== ''

  // The run's files: changed between the two looks. Already changed before and again now: both hands, left alone.
  const now = await signatures(exec, root, entries)
  const tracked = new Map(entries.map((entry) => [entry.path, entry.xy !== '??']))
  const candidates: string[] = []
  for (const [path, sig] of now) {
    const was = before.dirty.get(path)
    if (was === undefined) candidates.push(path)
    else if (was !== sig) result.mixed.push(path)
  }
  // Deleted by the run: clean before, gone now (already in `now` as gone:...). Reverted by the run: nothing to do.

  const anything = candidates.length > 0 || result.mixed.length > 0
  if (branch === '') {
    if (!anything && !madeCommits) return stop('nothing', '')
    return stop('skipped', 'detached HEAD', `Git: did not auto-commit in ${name}: it is on a detached HEAD (no branch), so nothing was committed or pushed.`)
  }
  const busy = await busyState(exec, root)
  if (busy !== '') return stop('skipped', `in the middle of ${busy}`, anything ? `Git: did not auto-commit in ${name}: it is in the middle of ${busy}.` : '')

  const toCommit: string[] = []
  for (const path of candidates) {
    const local = join(root, path)
    if (isJunk(path, tracked.get(path) === true)) {
      result.junk.push(path)
      continue
    }
    if (excludedBy(path, options.exclude)) {
      result.junk.push(path)
      continue
    }
    const gone = (now.get(path) ?? '').startsWith('gone:')
    if (!gone && sizeOf(local) > options.maxFileBytes) {
      result.tooBig.push(path)
      continue
    }
    const byName = secretByName(path)
    if (byName !== null) {
      result.secrets.push({ path, kind: byName })
      continue
    }
    if (!gone) {
      const text = readText(local, options.maxFileBytes)
      const kind = text === null ? null : secretInText(path, text, options.vault)
      if (kind !== null) {
        result.secrets.push({ path, kind })
        continue
      }
    }
    toCommit.push(path)
  }

  const problems: string[] = []
  if (result.secrets.length > 0) problems.push(`left out ${result.secrets.map((hit) => `${hit.path} (${hit.kind})`).join(', ')} and did not push`)
  if (result.mixed.length > 0) problems.push(`left ${plural(result.mixed.length, 'file')} you had already changed before the run (${result.mixed.slice(0, 3).join(', ')}${result.mixed.length > 3 ? ', ...' : ''})`)

  let committed = ''
  if (toCommit.length > 0) {
    const list = `${toCommit.join('\0')}\0`
    const add = await git(exec, root, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], list)
    if (add.code !== 0) return stop('failed', `git add: ${firstLine(add.err)}`, `Git: could not stage the run's files in ${name}: ${firstLine(add.err)}.`)
    // Only these paths go in, whatever else the person had staged (commit with paths = --only).
    const commit = await git(exec, root, ['commit', '--quiet', '-m', wipMessage(title), '--pathspec-from-file=-', '--pathspec-file-nul'], list, 120_000)
    if (commit.code !== 0) {
      // Put the index back as it was for these paths, so nothing is left half-staged.
      await git(exec, root, ['reset', '--quiet', '--pathspec-from-file=-', '--pathspec-file-nul'], list)
      const why = firstLine(commit.err) || firstLine(commit.out) || 'the commit failed'
      return stop('failed', `commit refused: ${why}`, `Git: the commit in ${name} was refused (${why}); nothing committed. A hook may need fixing.`)
    }
    committed = await headOf(exec, root)
    result.files = toCommit
    result.commit = committed.slice(0, 7)
    result.commitSha = committed
    result.status = 'committed'
  }

  const shouldPush = options.push && (committed !== '' || madeCommits)
  const facts = committed === '' ? '' : `committed ${plural(toCommit.length, 'file')} in ${name} (${branch}, ${result.commit})`
  const say = (parts: string[]): string => {
    const text = parts.filter((part) => part !== '').join('; ')
    return text === '' ? '' : `Git: ${text}.`
  }

  if (result.secrets.length > 0) {
    result.status = committed === '' ? 'blocked' : 'committed'
    result.reason = 'secret found'
    result.note = say([facts, ...problems])
    return result
  }
  if (!shouldPush) {
    result.reason = committed === '' ? (anything ? 'nothing of the run to commit' : '') : options.push ? '' : 'push is off'
    if (committed === '' && !anything) result.status = 'nothing'
    else if (committed === '') result.status = 'skipped'
    result.note = say([facts, ...problems])
    return result
  }
  // Unpushed commits from before the run are someone else's to push, unless the auto-commit made them itself.
  const foreign = before.aheadShas === undefined ? before.aheadBefore : before.aheadShas.filter((sha) => options.ownCommit?.(sha) !== true).length
  if (foreign > 0) {
    result.reason = `${plural(foreign, 'unpushed commit')} from before the run`
    result.note = say([facts, `not pushed: the branch already had ${plural(foreign, 'unpushed commit')} from before the run`, ...problems])
    return result
  }

  const pushed = await push(exec, root, branch)
  if (pushed.ok) {
    result.pushed = true
    result.status = 'pushed'
    result.note = say([`${facts === '' ? `pushed ${name} (${branch})` : `${facts} and pushed${pushed.how === '' ? '' : ` ${pushed.how}`}`}`, ...problems])
    return result
  }
  result.reason = pushed.why
  result.note = say([facts, `not pushed: ${pushed.why}`, ...problems])
  return result
}

/** Push the branch: -u to the one remote when it has no upstream; on a rejection fetch and rebase once. */
async function push(exec: GitExec, root: string, branch: string): Promise<{ ok: boolean; why: string; how: string }> {
  const upstream = await upstreamOf(exec, root)
  if (upstream === '') {
    const remotes = (await git(exec, root, ['remote'])).out.split(/\r?\n/).map((r) => r.trim()).filter((r) => r !== '')
    const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? (remotes[0] ?? '') : ''
    if (remote === '') return { ok: false, why: remotes.length === 0 ? 'the repo has no remote' : 'several remotes and no upstream, so it is unclear where to push', how: '' }
    const first = await git(exec, root, ['push', '--porcelain', '-u', remote, `HEAD:refs/heads/${branch}`], undefined, 180_000)
    if (first.code === 0) {
      // -u with HEAD:<branch> does not always set the upstream: set it plainly.
      await git(exec, root, ['branch', `--set-upstream-to=${remote}/${branch}`])
      return { ok: true, why: '', how: `(new branch on ${remote})` }
    }
    return { ok: false, why: firstLine(first.err) || 'the push failed', how: '' }
  }
  const slash = upstream.indexOf('/')
  const remote = upstream.slice(0, slash)
  const target = upstream.slice(slash + 1)
  const attempt = (): Promise<{ code: number; out: string; err: string }> => git(exec, root, ['push', '--porcelain', remote, `HEAD:refs/heads/${target}`], undefined, 180_000)
  const first = await attempt()
  if (first.code === 0) return { ok: true, why: '', how: '' }
  const text = `${first.out}\n${first.err}`
  if (!/rejected|non-fast-forward|fetch first|stale info/i.test(text)) return { ok: false, why: firstLine(first.err) || 'the push failed', how: '' }
  // Rejected: someone pushed first. Fetch and rebase once, only when no other change of the person's is in the way.
  const other = await git(exec, root, ['status', '--porcelain', '--untracked-files=no'])
  if (other.out.trim() !== '') return { ok: false, why: 'the remote has newer commits, and other uncommitted changes in the folder stop a rebase', how: '' }
  const fetched = await git(exec, root, ['fetch', '--quiet', remote], undefined, 180_000)
  if (fetched.code !== 0) return { ok: false, why: `rejected, and the fetch failed: ${firstLine(fetched.err)}`, how: '' }
  const rebase = await git(exec, root, ['rebase', '--quiet', upstream], undefined, 120_000)
  if (rebase.code !== 0) {
    await git(exec, root, ['rebase', '--abort'])
    return { ok: false, why: 'the remote has newer commits that conflict with this work (rebase stopped and undone)', how: '' }
  }
  const second = await attempt()
  if (second.code === 0) return { ok: true, why: '', how: 'after a rebase on the newer remote' }
  return { ok: false, why: `rejected again after a rebase: ${firstLine(second.err)}`, how: '' }
}
