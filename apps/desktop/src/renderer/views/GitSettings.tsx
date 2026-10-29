/**
 * Settings > Git (main/git/hook.ts): after a helper run or a chat turn that worked in a git repo, what that run
 * changed is committed as "WIP: <run title>" on the branch the repo is on and pushed. Secrets, build output, big
 * files and the person's own edits are left out. Here: on/off, push on/off, the size limit, more patterns to leave
 * out, the log of what was committed and pushed per run, and which project folders still hold unpushed work.
 */
import type { GitLogEntry, GitRepoState } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent } from '../bridge'
import { timeAgo } from '../lib/format'
import { useSettings } from '../state/useSettings'
import { toast } from '../state/useToast'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { SectionHeader } from '../ui/SectionHeader'
import { Switch } from '../ui/Switch'

const SIZES = [1, 2, 5, 10, 25, 50, 100]

function repoName(root: string): string {
  return root.split(/[\\/]/).filter((part) => part !== '').pop() ?? root
}

function files(n: number): string {
  return `${n} file${n === 1 ? '' : 's'}`
}

/** One log entry in plain words. */
export function outcome(entry: GitLogEntry): string {
  if (entry.status === 'pushed') return `Committed ${files(entry.files)} and pushed`
  if (entry.status === 'committed') return `Committed ${files(entry.files)}${entry.reason === '' ? '' : `, not pushed: ${entry.reason}`}`
  if (entry.status === 'blocked') return 'Not committed: a secret was found, nothing pushed'
  if (entry.status === 'skipped') return `Skipped: ${entry.reason}`
  if (entry.status === 'failed') return `Failed: ${entry.reason}`
  return 'Nothing to commit'
}

/** What is waiting in a project folder, '' when nothing. */
export function waiting(state: GitRepoState): string {
  const parts: string[] = []
  if (state.uncommitted > 0) parts.push(`${state.uncommitted} uncommitted`)
  if (state.ahead > 0) parts.push(`${state.ahead} unpushed`)
  if (state.noUpstream && !state.detached) parts.push('never pushed')
  if (state.detached) parts.push('detached HEAD')
  return parts.join(', ')
}

export function GitSettings(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const [log, setLog] = useState<GitLogEntry[]>([])
  const [repos, setRepos] = useState<GitRepoState[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [exclude, setExclude] = useState(settings?.gitExclude ?? '')
  useEffect(() => setExclude(settings?.gitExclude ?? ''), [settings?.gitExclude])

  useEffect(() => {
    let live = true
    const read = (): void => {
      void agent.git
        .log()
        .then((list) => live && setLog(list))
        .catch(() => undefined)
    }
    read()
    const timer = setInterval(read, 15_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])

  const check = (): void => {
    setChecking(true)
    void agent.git
      .report()
      .then((list) => setRepos(list))
      .catch(() => toast('Could not read the project folders.'))
      .finally(() => setChecking(false))
  }

  const on = settings?.gitAutoCommit === true
  const size = settings?.gitMaxFileMb ?? 5
  const pending = (repos ?? []).filter((r) => waiting(r) !== '')

  return (
    <section className="gitset">
      <SectionHeader eyebrow="GIT" line="Finished work is committed and pushed after every run" />
      <div className="card wake-card">
        <p className="small muted wake-lead">
          After a helper or a chat works in a project&apos;s git folder, what that run changed is committed as &quot;WIP: the
          run&apos;s title&quot; on the branch it is on, then pushed. Never a new branch, never forced. Secrets, .env files, build
          output, big files and anything you had already changed yourself are left out, and a secret stops the push.
        </p>

        <div className="rowc">
          <div className="ri">
            <Icon name="branch" size={22} />
          </div>
          <div className="rt">
            <b>Commit after each run</b>
            <span>Only the files that run changed, on the current branch</span>
          </div>
          <Switch on={on} onToggle={(next) => void save({ gitAutoCommit: next })} label="Commit after each run" />
        </div>

        <div className="rowc">
          <div className="ri">
            <Icon name="sync" size={22} />
          </div>
          <div className="rt">
            <b>Push after the commit</b>
            <span>A branch never pushed gets its upstream set. A rejected push is rebased once, never forced.</span>
          </div>
          <Switch on={settings?.gitAutoPush !== false} onToggle={(next) => void save({ gitAutoPush: next })} label="Push after the commit" />
        </div>

        <div className="rowc">
          <div className="ri">
            <Icon name="file" size={22} />
          </div>
          <div className="rt">
            <b>Biggest file</b>
            <span>Files bigger than this are never committed</span>
          </div>
          <select className="rule-sel" aria-label="Biggest file" value={size} onChange={(event) => void save({ gitMaxFileMb: Number(event.target.value) })}>
            {(SIZES.includes(size) ? SIZES : [...SIZES, size]).map((mb) => (
              <option key={mb} value={mb}>
                {mb} MB
              </option>
            ))}
          </select>
        </div>

        <div className="rowc gitset-ex">
          <div className="ri">
            <Icon name="eyeoff" size={22} />
          </div>
          <div className="rt">
            <b>Also leave out</b>
            <span>Patterns, comma separated: *.mp4, scratch/, data/**</span>
          </div>
          <input
            className="input gitset-input"
            aria-label="Also leave out"
            placeholder="Nothing more"
            value={exclude}
            onChange={(event) => setExclude(event.target.value)}
            onBlur={() => {
              if (exclude !== (settings?.gitExclude ?? '')) void save({ gitExclude: exclude }).catch(() => toast('Could not change that.'))
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
            }}
          />
        </div>

        <div className="wake-block">
          <div className="gitset-head">
            <b className="wake-h">Waiting to be pushed</b>
            <Button variant="tonal" size="sm" disabled={checking} onClick={check}>
              {checking ? 'Checking' : repos === null ? 'Check projects' : 'Check again'}
            </Button>
          </div>
          {repos === null ? <p className="small muted wake-none">Looks at every project folder: uncommitted files, unpushed commits, branches never pushed.</p> : null}
          {repos !== null && pending.length === 0 ? <p className="small muted wake-none">Every project folder is committed and pushed.</p> : null}
          {pending.map((r) => (
            <div key={r.root} className="gitset-row">
              <b>{r.name}</b>
              <span className="small muted">
                {r.detached ? 'no branch' : r.branch} · {waiting(r)}
              </span>
            </div>
          ))}
        </div>

        <div className="wake-block">
          <b className="wake-h">What was committed</b>
          {log.length === 0 ? <p className="small muted wake-none">{on ? 'Nothing yet. Each run that changes files in a repo shows here.' : 'Switched off.'}</p> : null}
          {log.slice(0, 20).map((entry) => (
            <div key={`${entry.at}-${entry.repo}`} className={`gitset-row${entry.status === 'pushed' || entry.status === 'committed' ? '' : ' warn'}`}>
              <div className="gitset-top">
                <b>{repoName(entry.repo)}</b>
                <span className="small muted">
                  {entry.branch === '' ? '' : `${entry.branch} · `}
                  {entry.commit === undefined ? '' : `${entry.commit} · `}
                  {timeAgo(entry.at)}
                </span>
              </div>
              <span className="small">{outcome(entry)}</span>
              <span className="small muted gitset-title">{entry.title}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
