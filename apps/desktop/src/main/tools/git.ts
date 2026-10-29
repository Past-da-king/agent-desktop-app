/**
 * Git tools (Settings > Git): git_status_report (which project folders hold uncommitted or unpushed work, only what
 * changed since the last report, for a nightly routine) and git_autocommit_log (what the auto-commit hook committed
 * and pushed per run). Both read only; the report remembers its last answer on this device.
 */
import { bool, schema, str, type Tool } from '@agent/core'

import type { DataStore } from '../runtime/data'
import type { RunGitHook, KeyValue } from '../git/hook'
import { gitStatusReport } from '../git/report'
import type { GitExec } from '../git/git-exec'

export interface GitToolDeps {
  store: DataStore
  kv: KeyValue
  hook?: () => RunGitHook | null
  exec?: GitExec
}

export function gitTools(deps: GitToolDeps): Tool[] {
  return [
    {
      spec: {
        name: 'git_status_report',
        description:
          "Which project folders (each project's folder, plus any folders you name) hold uncommitted changes, unpushed commits, a branch never pushed, or a detached HEAD. By default it says only what CHANGED since the last report (new, changed, now clean) and 'NOTHING NEW' when nothing did, so a nightly routine stays quiet; full: true lists every folder that needs attention. Read-only: no fetch, no commit.",
        schema: schema([], {
          full: bool('List everything that needs attention, not only what changed'),
          folders: str('Extra folders to check, comma separated (optional)'),
        }),
      },
      run: async (input) => {
        const projects = await deps.store.list('project').catch(() => [])
        const folders = projects.filter((project) => project.path.trim() !== '').map((project) => ({ name: project.name, path: project.path }))
        const extra = typeof input['folders'] === 'string' ? input['folders'].split(',').map((part) => part.trim()).filter((part) => part !== '') : []
        for (const path of extra) folders.push({ name: path.split(/[\\/]/).filter((p) => p !== '').pop() ?? path, path })
        if (folders.length === 0) return 'No project has a folder, and no folder was named.'
        const report = await gitStatusReport(folders, deps.kv, { full: input['full'] === true, ...(deps.exec === undefined ? {} : { exec: deps.exec }) })
        return report.text
      },
    },
    {
      spec: {
        name: 'git_autocommit_log',
        description: 'What the auto-commit hook (Settings > Git) committed and pushed after each run, newest first: repo, branch, commit, files, pushed or why not.',
        schema: schema([], { limit: str('How many, default 20') }),
      },
      run: async (input) => {
        const hook = deps.hook?.() ?? null
        if (hook === null) return 'The auto-commit hook is not running here.'
        const limit = Math.min(200, Math.max(1, Number(input['limit']) || 20))
        const entries = hook.log(limit)
        const state = hook.enabled() ? 'on' : 'off (Settings > Git)'
        if (entries.length === 0) return `Auto-commit is ${state}. Nothing committed yet.`
        return [
          `Auto-commit is ${state}.`,
          ...entries.map(
            (e) =>
              `${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')} ${e.status} ${e.repo}${e.branch === '' ? '' : ` (${e.branch})`}${e.commit === undefined ? '' : ` ${e.commit}`} ${e.files} file(s)${e.pushed ? ', pushed' : ''}${e.reason === '' ? '' : `: ${e.reason}`} [${e.title}]`,
          ),
        ].join('\n')
      },
    },
  ]
}
