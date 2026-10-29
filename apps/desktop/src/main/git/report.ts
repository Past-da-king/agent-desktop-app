/**
 * git_status_report: which project folders hold uncommitted or unpushed work, telling only what changed since the
 * last report (kept on this device). Made for a nightly routine: a night where nothing changed says nothing.
 * Read-only on the repos: no fetch, no commit; "ahead" is against the last fetched upstream.
 */
import { defaultGitExec, type GitExec } from './git-exec'
import { parsePorcelain, repoRootOf } from './autocommit'
import type { KeyValue } from './hook'

export interface RepoState {
  name: string
  root: string
  branch: string
  uncommitted: number
  ahead: number
  noUpstream: boolean
  detached: boolean
}

const BASE_KEY = 'git.report.last'

/** A repo's state in one line. */
export function describeRepo(state: RepoState): string {
  const parts: string[] = []
  if (state.uncommitted > 0) parts.push(`${state.uncommitted} uncommitted`)
  if (state.ahead > 0) parts.push(`${state.ahead} unpushed commit${state.ahead === 1 ? '' : 's'}`)
  if (state.noUpstream && !state.detached) parts.push('no upstream (never pushed)')
  if (state.detached) parts.push('detached HEAD')
  return `${state.name} (${state.detached ? 'no branch' : state.branch}): ${parts.join(', ')}`
}

/** Is there anything to report in this repo? */
export function needsAttention(state: RepoState): boolean {
  return state.uncommitted > 0 || state.ahead > 0 || state.noUpstream || state.detached
}

export async function repoState(name: string, folder: string, exec: GitExec = defaultGitExec): Promise<RepoState | null> {
  const root = await repoRootOf(folder, exec).catch(() => null)
  if (root === null) return null
  const branch = await exec(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const status = await exec(root, ['status', '--porcelain=v1', '-z'], { timeoutMs: 60_000 })
  const upstream = await exec(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const noUpstream = upstream.code !== 0
  const ahead = noUpstream ? { code: 1, out: '0' } : await exec(root, ['rev-list', '--count', '@{u}..HEAD'])
  return {
    name,
    root,
    branch: branch.code === 0 ? branch.out.trim() : '',
    detached: branch.code !== 0,
    uncommitted: status.code === 0 ? parsePorcelain(status.out).length : 0,
    ahead: ahead.code === 0 ? Number(ahead.out.trim()) || 0 : 0,
    noUpstream,
  }
}

/**
 * The report: lines for repos whose state changed since the last report (new, changed, or now clean). `full` lists
 * every repo that needs attention and makes this the new baseline too.
 */
export async function gitStatusReport(
  folders: Array<{ name: string; path: string }>,
  kv: KeyValue,
  options: { full?: boolean; exec?: GitExec } = {},
): Promise<{ text: string; changed: number; repos: RepoState[] }> {
  const exec = options.exec ?? defaultGitExec
  const seenRoots = new Set<string>()
  const states: RepoState[] = []
  for (const folder of folders) {
    if (folder.path.trim() === '') continue
    const state = await repoState(folder.name, folder.path.trim(), exec).catch(() => null)
    if (state === null || seenRoots.has(state.root.toLowerCase())) continue
    seenRoots.add(state.root.toLowerCase())
    states.push(state)
  }
  let before: Record<string, string> = {}
  try {
    const parsed: unknown = JSON.parse(kv.get(BASE_KEY) ?? '{}')
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) before = parsed as Record<string, string>
  } catch {
    before = {}
  }
  const now: Record<string, string> = {}
  const lines: string[] = []
  for (const state of states) {
    const key = state.root.toLowerCase()
    const line = needsAttention(state) ? describeRepo(state) : ''
    if (line !== '') now[key] = line
    if (options.full === true) {
      if (line !== '') lines.push(line)
    } else if (line !== '' && before[key] !== line) {
      lines.push(before[key] === undefined ? line : `${line} (was: ${before[key]?.replace(/^[^:]*:\s*/, '')})`)
    } else if (line === '' && before[key] !== undefined) {
      lines.push(`${state.name} (${state.branch || 'no branch'}): now clean and pushed`)
    }
  }
  kv.set(BASE_KEY, JSON.stringify(now))
  const text = lines.length === 0 ? (options.full === true ? 'Every project folder is committed and pushed.' : 'NOTHING NEW') : lines.join('\n')
  return { text, changed: lines.length, repos: states }
}
