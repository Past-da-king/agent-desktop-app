/**
 * Auto-commit and push after a run (Settings > Git, main/git/). Real git in temp repos with a local bare remote:
 * a run's changes are committed and pushed; a planted secret is left out and stops the push; node_modules and
 * other junk are skipped; the person's own edits are never touched; a detached HEAD is skipped; a branch with no
 * upstream gets push -u; a rejected push is rebased once (and undone on conflict); a failing pre-commit hook is
 * reported, never bypassed. Then the hook through a real helper run, and the delta-only status report.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS, MAIN_CHAT, providerFor, schema, type Settings, type Tool } from '@agent/core'

import { startFakeAi } from '../../../packages/core/test/fake-ai'
import { sleep, waitFor } from '../../../packages/core/test/helpers'
import { commitRun, excludedBy, isJunk, snapshot, wipMessage, type AutoCommitOptions } from '../src/main/git/autocommit'
import { RunGitHook, pathsOfCall, type GitSettings } from '../src/main/git/hook'
import { gitStatusReport } from '../src/main/git/report'
import { secretByName, secretInText, vaultHashesOf } from '../src/main/git/secret-scan'
import { wslTarget } from '../src/main/git/git-exec'
import { Store } from '../src/main/db'
import { HelperManager } from '../src/main/runtime/helpers'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset, buildWorkerToolset } from '../src/main/runtime/toolset'
import { secretsView, settingsView } from './support'

// Real git, many calls per test: slow on Windows.
vi.setConfig({ testTimeout: 30_000 })

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

/** A repo with one commit on main, cloned from a bare remote (upstream set). */
function repo(options: { remote?: boolean; upstream?: boolean } = {}): { root: string; bare: string } {
  const base = mkdtempSync(join(tmpdir(), 'agent-git-'))
  temps.push(base)
  const bare = join(base, 'remote.git')
  const root = join(base, 'work')
  git(base, 'init', '--quiet', '--bare', '--initial-branch=main', bare)
  git(base, 'init', '--quiet', '--initial-branch=main', root)
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'user.email', 'test@example.invalid')
  git(root, 'config', 'core.autocrlf', 'false')
  git(root, 'config', 'commit.gpgsign', 'false')
  write(root, 'README.md', 'hello\n')
  write(root, 'src/app.ts', 'export const a = 1\n')
  write(root, '.gitignore', 'ignored/\n')
  git(root, 'add', '-A')
  git(root, 'commit', '--quiet', '-m', 'first')
  if (options.remote !== false) {
    git(root, 'remote', 'add', 'origin', bare)
    if (options.upstream !== false) git(root, 'push', '--quiet', '-u', 'origin', 'main')
  }
  return { root, bare }
}

const OPTIONS: AutoCommitOptions = { push: true, maxFileBytes: 5 * 1024 * 1024, exclude: [] }

function remoteLog(bare: string, branch = 'main'): string {
  return git(bare, 'log', '--format=%s', branch)
}

// Key-shaped strings are made at run time so this file itself never holds one.
const FAKE_GH = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('')
const FAKE_AWS = ['AK', 'IA', 'QWERTYUIOPASDFGH'].join('')

describe('commitRun: what a run changed is committed and pushed', () => {
  it('commits only the files the run changed, as WIP: <title>, on the current branch, and pushes', async () => {
    const { root, bare } = repo()
    const before = await snapshot(root)
    write(root, 'src/app.ts', 'export const a = 2\n')
    write(root, 'src/new.ts', 'export const b = 1\n')
    const result = await commitRun(before!, 'Fix the counter', OPTIONS)
    expect(result.status).toBe('pushed')
    expect(result.files.sort()).toEqual(['src/app.ts', 'src/new.ts'])
    expect(git(root, 'log', '-1', '--format=%s')).toBe('WIP: Fix the counter')
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(remoteLog(bare).split('\n')[0]).toBe('WIP: Fix the counter')
    expect(git(root, 'status', '--porcelain')).toBe('')
    expect(result.note).toMatch(/^Git: committed 2 files in work \(main, [0-9a-f]{7}\) and pushed\.$/)
  })

  it('a planted secret is left out and nothing is pushed; the note names the file and kind, never the value', async () => {
    const { root, bare } = repo()
    const before = await snapshot(root)
    write(root, 'src/config.ts', `export const token = '${FAKE_GH}'\n`)
    write(root, '.env', 'API=1\n')
    write(root, 'src/ok.ts', 'export const fine = true\n')
    const result = await commitRun(before!, 'Add config', OPTIONS)
    expect(result.secrets.map((s) => s.path).sort()).toEqual(['.env', 'src/config.ts'])
    expect(result.files).toEqual(['src/ok.ts'])
    expect(result.pushed).toBe(false)
    expect(remoteLog(bare)).toBe('first')
    expect(git(root, 'ls-files')).not.toContain('config.ts')
    expect(git(root, 'ls-files')).not.toContain('.env')
    expect(result.note).toContain('src/config.ts (a GitHub token)')
    expect(result.note).toContain('did not push')
    expect(result.note).not.toContain(FAKE_GH)
  })

  it('a vault value is found by hash only', async () => {
    const { root } = repo()
    const before = await snapshot(root)
    write(root, 'notes.txt', 'login is admin and the code is Zq8-pR4-mT2x-house\n')
    const vault = vaultHashesOf(['Zq8-pR4-mT2x-house', 'short'])
    expect(vault.hashes.size).toBe(1)
    const result = await commitRun(before!, 'Notes', { ...OPTIONS, vault })
    expect(result.secrets).toEqual([{ path: 'notes.txt', kind: 'a value from the Vault' }])
    expect(result.status).toBe('blocked')
    expect(JSON.stringify(result)).not.toContain('Zq8-pR4')
  })

  it('skips node_modules, build output, databases, logs, ignored files and files over the size limit', async () => {
    const { root, bare } = repo()
    const before = await snapshot(root)
    write(root, 'node_modules/x/index.js', 'module.exports = 1\n')
    write(root, 'dist/app.js', 'x\n')
    write(root, 'data/app.db', 'sqlite\n')
    write(root, 'server.log', 'log\n')
    write(root, 'ignored/thing.txt', 'x\n')
    write(root, 'big.bin', 'x'.repeat(2048))
    write(root, 'src/real.ts', 'export const r = 1\n')
    const result = await commitRun(before!, 'Build', { ...OPTIONS, maxFileBytes: 1024 })
    expect(result.files).toEqual(['src/real.ts'])
    expect(result.junk.sort()).toEqual(['data/app.db', 'dist/app.js', 'node_modules/x/index.js', 'server.log'])
    expect(result.tooBig).toEqual(['big.bin'])
    expect(git(bare, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('node_modules')
  })

  it('never touches the person\'s own edits: changed before and unchanged stays; changed before and again is left and named', async () => {
    const { root } = repo()
    write(root, 'README.md', 'his edit\n')
    write(root, 'his-draft.md', 'draft\n')
    write(root, 'src/app.ts', 'export const a = 10 // his\n')
    write(root, 'staged-by-him.txt', 'staged\n')
    git(root, 'add', 'staged-by-him.txt')
    const before = await snapshot(root)
    write(root, 'src/app.ts', 'export const a = 11 // his + run\n')
    write(root, 'src/run.ts', 'export const run = 1\n')
    const result = await commitRun(before!, 'Run work', OPTIONS)
    expect(result.files).toEqual(['src/run.ts'])
    expect(result.mixed).toEqual(['src/app.ts'])
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('src/run.ts')
    const left = git(root, 'status', '--porcelain')
    expect(left).toMatch(/^ ?M README.md$/m)
    expect(left).toContain('?? his-draft.md')
    expect(left).toContain(' M src/app.ts')
    // His staged file stays staged and was not swept into the run's commit.
    expect(left).toContain('A  staged-by-him.txt')
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('his edit\n')
    expect(result.note).toContain('you had already changed before the run (src/app.ts)')
  })

  it('a detached HEAD is skipped and says so', async () => {
    const { root, bare } = repo()
    git(root, 'checkout', '--quiet', '--detach')
    const before = await snapshot(root)
    write(root, 'src/x.ts', 'x\n')
    const result = await commitRun(before!, 'Detached', OPTIONS)
    expect(result.status).toBe('skipped')
    expect(result.note).toContain('detached HEAD')
    expect(git(root, 'status', '--porcelain')).toContain('?? src/x.ts')
    expect(remoteLog(bare)).toBe('first')
  })

  it('a branch with no upstream is pushed with -u to its one remote', async () => {
    const { root, bare } = repo({ upstream: false })
    const before = await snapshot(root)
    write(root, 'src/y.ts', 'y\n')
    const result = await commitRun(before!, 'First push', OPTIONS)
    expect(result.status).toBe('pushed')
    expect(git(root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')).toBe('origin/main')
    expect(remoteLog(bare).split('\n')[0]).toBe('WIP: First push')
  })

  it('no remote: committed, not pushed, and says why', async () => {
    const { root } = repo({ remote: false })
    const before = await snapshot(root)
    write(root, 'src/z.ts', 'z\n')
    const result = await commitRun(before!, 'Local only', OPTIONS)
    expect(result.status).toBe('committed')
    expect(result.note).toContain('not pushed: the repo has no remote')
  })

  it('a rejected push is fetched and rebased once, then pushed; never forced', async () => {
    const { root, bare } = repo()
    // Someone else pushes first.
    const other = join(dirname(root), 'other')
    git(dirname(root), 'clone', '--quiet', bare, other)
    git(other, 'config', 'user.name', 'Other')
    git(other, 'config', 'user.email', 'other@example.invalid')
    write(other, 'theirs.txt', 'theirs\n')
    git(other, 'add', '-A')
    git(other, 'commit', '--quiet', '-m', 'their work')
    git(other, 'push', '--quiet')
    const before = await snapshot(root)
    write(root, 'src/mine.ts', 'mine\n')
    const result = await commitRun(before!, 'My work', OPTIONS)
    expect(result.status).toBe('pushed')
    expect(result.note).toContain('after a rebase')
    expect(remoteLog(bare).split('\n')).toEqual(['WIP: My work', 'their work', 'first'])
  })

  it('a rejected push that conflicts: the rebase is undone, nothing forced, the commit stays local', async () => {
    const { root, bare } = repo()
    const other = join(dirname(root), 'other')
    git(dirname(root), 'clone', '--quiet', bare, other)
    git(other, 'config', 'user.name', 'Other')
    git(other, 'config', 'user.email', 'other@example.invalid')
    write(other, 'src/app.ts', 'export const a = "theirs"\n')
    git(other, 'commit', '--quiet', '-am', 'their change')
    git(other, 'push', '--quiet')
    const before = await snapshot(root)
    write(root, 'src/app.ts', 'export const a = "mine"\n')
    const result = await commitRun(before!, 'Conflict', OPTIONS)
    expect(result.status).toBe('committed')
    expect(result.pushed).toBe(false)
    expect(result.note).toContain('conflict')
    expect(remoteLog(bare).split('\n')[0]).toBe('their change')
    expect(git(root, 'log', '-1', '--format=%s')).toBe('WIP: Conflict')
    expect(git(root, 'status', '--porcelain')).toBe('')
  })

  it('a failing pre-commit hook is reported and not bypassed; the index is put back', async () => {
    const { root, bare } = repo()
    const hook = join(root, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho "lint failed" >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    const before = await snapshot(root)
    write(root, 'src/h.ts', 'h\n')
    const result = await commitRun(before!, 'Hooked', OPTIONS)
    expect(result.status).toBe('failed')
    expect(result.note).toContain('refused')
    expect(result.note).toContain('lint failed')
    expect(git(root, 'log', '-1', '--format=%s')).toBe('first')
    expect(git(root, 'status', '--porcelain')).toBe('?? src/h.ts')
    expect(remoteLog(bare)).toBe('first')
  })

  it('a run that made its own commits gets them pushed; earlier unpushed commits of someone else stop the push', async () => {
    const { root, bare } = repo()
    const before = await snapshot(root)
    write(root, 'a.txt', 'a\n')
    git(root, 'add', 'a.txt')
    git(root, 'commit', '--quiet', '-m', 'run commit')
    const pushed = await commitRun(before!, 'Self commit', OPTIONS)
    expect(pushed.status).toBe('pushed')
    expect(remoteLog(bare).split('\n')[0]).toBe('run commit')

    write(root, 'b.txt', 'b\n')
    git(root, 'add', 'b.txt')
    git(root, 'commit', '--quiet', '-m', 'his local commit')
    const again = await snapshot(root)
    write(root, 'c.txt', 'c\n')
    const held = await commitRun(again!, 'After his commit', OPTIONS)
    expect(held.status).toBe('committed')
    expect(held.note).toContain('already had 1 unpushed commit from before the run')
    expect(remoteLog(bare).split('\n')[0]).toBe('run commit')
  })
})

describe('the secret check and the filters', () => {
  it('finds key shapes and config passwords, skips placeholders and allow-marked lines', () => {
    expect(secretInText('a.ts', `const k = "${FAKE_AWS}"`)).toBe('an AWS access key')
    expect(secretInText('a.ts', `const k = "${FAKE_GH}"`)).toBe('a GitHub token')
    expect(secretInText('a.ts', ['sk-', 'ant-', 'abcdefghijklmnopqrstuvwxyz0123'].join(''))).toBe('an Anthropic key')
    expect(secretInText('a.ts', ['gsk', '_', 'a'.repeat(48)].join(''))).toBe('a Groq key')
    expect(secretInText('a.ts', ['xox', 'b-', '1234567890-abcdefghij'].join(''))).toBe('a Slack token')
    expect(secretInText('a.ts', ['AI', 'za', 'B'.repeat(35)].join(''))).toBe('a Google API key')
    expect(secretInText('a.ts', ['eyJ', 'hbGciOiJIUzI1NiJ9', '.eyJ', 'zdWIiOiIxMjM0NTY3ODkw', '.', 'abcdefghijklmnop'].join(''))).toBe('a JWT')
    expect(secretInText('k.txt', ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join(''))).toBe('a private key')
    expect(secretInText('db.yml', 'password: hunter2secret')).toBe('a password in a config file')
    expect(secretInText('db.yml', 'password: ${DB_PASSWORD}')).toBeNull()
    expect(secretInText('db.yml', 'password: changeme')).toBeNull()
    expect(secretInText('login.ts', 'const password = form.value')).toBeNull()
    expect(secretInText('a.ts', `const k = "${FAKE_AWS}" // secret-scan:allow`)).toBeNull()
    expect(secretByName('.env.local')).toBe('an .env file')
    expect(secretByName('.env.example')).toBeNull()
    expect(secretByName('certs/server.pem')).toBe('a key file')
    expect(secretByName('id_ed25519')).toBe('an SSH private key')
    expect(secretByName('id_ed25519.pub')).toBeNull()
  })

  it('junk and extra patterns', () => {
    expect(isJunk('node_modules/a/b.js', false)).toBe(true)
    expect(isJunk('apps/x/build/icon.png', true)).toBe(false)
    expect(isJunk('apps/x/build/icon.png', false)).toBe(true)
    expect(isJunk('db/data.sqlite', true)).toBe(true)
    expect(excludedBy('media/clip.mp4', ['*.mp4'])).toBe(true)
    expect(excludedBy('scratch/a.txt', ['scratch/'])).toBe(true)
    expect(excludedBy('src/scratch.ts', ['scratch/'])).toBe(false)
    expect(excludedBy('data/deep/x.csv', ['data/**'])).toBe(true)
    expect(wipMessage('  Fix\nthe   thing ')).toBe('WIP: Fix the thing')
  })

  it('tool calls name the repos a run works in; WSL shares map to their distro', () => {
    const abs = process.platform === 'win32' ? 'C:\\work\\a.ts' : '/work/a.ts'
    expect(pathsOfCall({ file_path: abs, other: 'x' })).toEqual([abs])
    expect(pathsOfCall({ command: 'ls', cwd: 'relative' })).toEqual([])
    expect(wslTarget('\\\\wsl.localhost\\Ubuntu\\home\\me\\proj')).toEqual({ distro: 'Ubuntu', path: '/home/me/proj' })
    expect(wslTarget('//wsl$/Debian/srv')).toEqual({ distro: 'Debian', path: '/srv' })
    expect(wslTarget('C:\\temp')).toBeNull()
  })
})

function kv(): { get(k: string): string | null; set(k: string, v: string): void; map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v) }
}

function gitSettings(patch: Partial<GitSettings> = {}): () => GitSettings {
  return () => ({ gitAutoCommit: true, gitAutoPush: true, gitMaxFileMb: 5, gitExclude: '', ...patch })
}

describe('RunGitHook', () => {
  it('off: nothing is looked at or committed', async () => {
    const { root } = repo()
    const hook = new RunGitHook({ settings: gitSettings({ gitAutoCommit: false }), kv: kv() })
    await hook.begin('r1', root)
    write(root, 'x.txt', 'x\n')
    const ended = await hook.end('r1', 'Off')
    expect(ended.results).toEqual([])
    expect(git(root, 'log', '-1', '--format=%s')).toBe('first')
  })

  it('commits in the begin folder and in a repo first touched by a tool call, and logs each', async () => {
    const one = repo()
    const two = repo()
    const store = kv()
    const hook = new RunGitHook({ settings: gitSettings(), kv: store })
    await hook.begin('r2', one.root)
    write(one.root, 'one.txt', '1\n')
    await hook.touch('r2', { file_path: join(two.root, 'two.txt') })
    write(two.root, 'two.txt', '2\n')
    const ended = await hook.end('r2', 'Two repos')
    expect(ended.results.map((r) => r.status)).toEqual(['pushed', 'pushed'])
    expect(remoteLog(one.bare).split('\n')[0]).toBe('WIP: Two repos')
    expect(remoteLog(two.bare).split('\n')[0]).toBe('WIP: Two repos')
    expect(hook.log().map((e) => e.status)).toEqual(['pushed', 'pushed'])
    expect(ended.problem).toBe(false)
  })

  it('push off: committed, not pushed', async () => {
    const { root, bare } = repo()
    const hook = new RunGitHook({ settings: gitSettings({ gitAutoPush: false }), kv: kv() })
    await hook.begin('r3', root)
    write(root, 'p.txt', 'p\n')
    const ended = await hook.end('r3', 'No push')
    expect(ended.results[0]?.status).toBe('committed')
    expect(remoteLog(bare)).toBe('first')
  })
})

describe('git_status_report: only what changed since the last report', () => {
  it('lists, then says nothing new, then the change, then now clean', async () => {
    const { root } = repo()
    const store = kv()
    const folders = [{ name: 'Proj', path: root }]
    write(root, 'a.txt', 'a\n')
    const first = await gitStatusReport(folders, store)
    expect(first.text).toBe('Proj (main): 1 uncommitted')
    expect((await gitStatusReport(folders, store)).text).toBe('NOTHING NEW')
    write(root, 'b.txt', 'b\n')
    expect((await gitStatusReport(folders, store)).text).toBe('Proj (main): 2 uncommitted (was: 1 uncommitted)')
    git(root, 'add', '-A')
    git(root, 'commit', '--quiet', '-m', 'local')
    expect((await gitStatusReport(folders, store)).text).toBe('Proj (main): 1 unpushed commit (was: 2 uncommitted)')
    git(root, 'push', '--quiet')
    expect((await gitStatusReport(folders, store)).text).toBe('Proj (main): now clean and pushed')
    expect((await gitStatusReport(folders, store)).text).toBe('NOTHING NEW')
    expect((await gitStatusReport(folders, store, { full: true })).text).toBe('Every project folder is committed and pushed.')
  })
})

describe('a real helper run in a project folder', () => {
  const READY: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false }

  it('its file write is committed and pushed when it ends, and the result it hands back says so', async () => {
    const { root, bare } = repo()
    write(root, 'his-own.md', 'his\n')
    const writer: Tool = {
      spec: { name: 'write_note', description: 'Write a file.', schema: schema(['path', 'text'], {}) },
      run: async (input) => {
        writeFileSync(String(input['path']), String(input['text']))
        return 'written'
      },
    }
    const target = join(root, 'src', 'helper.ts')
    let step = 0
    const fake = await startFakeAi((body) => {
      if (!JSON.stringify(body).includes('You are a HELPER')) return { text: 'ok' }
      step += 1
      return step === 1 ? { toolCalls: [{ name: 'write_note', input: { path: target, text: 'export const h = 1\n' } }] } : { text: 'Wrote the helper file.' }
    })
    const db = new Store(':memory:')
    const project = await db.upsert('project', { name: 'Proj', description: '', path: root, profile: '', hidden: false, chats: ['pchat'] })
    expect(project.path).toBe(root)
    const delivered: string[] = []
    const settings: Partial<Settings> = { ...READY }
    const hook = new RunGitHook({ settings: () => ({ ...DEFAULT_SETTINGS, ...settings, gitAutoCommit: true }) as GitSettings, kv: kv() })
    const manager = new HelperManager({
      store: db,
      settings: settingsView(settings),
      secrets: secretsView('test-key'),
      providerFactory: () => providerFor({ provider: 'openai', key: 'test-key', baseUrl: fake.url, allowHttp: true }),
      workerTools: [...buildWorkerToolset({ store: db }), writer],
      deliver: (note) => {
        delivered.push(note)
      },
      platform: 'linux',
      timeZone: 'UTC',
      git: hook,
    })
    try {
      await manager.delegate([{ label: 'Write helper file', brief: 'Write the file.' }], false, { chat: 'pchat' })
      await waitFor(() => delivered.length > 0, 15_000)
      await sleep(100)
      expect(delivered[0]).toContain('Wrote the helper file.')
      expect(delivered[0]).toMatch(/Git: committed 1 file in work \(main, [0-9a-f]{7}\) and pushed\./)
      expect(remoteLog(bare).split('\n')[0]).toBe('WIP: Write helper file')
      expect(git(bare, 'show', '--name-only', '--format=', 'main')).toBe('src/helper.ts')
      expect(git(root, 'status', '--porcelain')).toBe('?? his-own.md')
    } finally {
      await manager.stopAll()
      manager.shutdown()
      await fake.close()
      db.close()
    }
  })

  it('stays out of the way when it is off or there is no project folder', async () => {
    void MAIN_CHAT
    const hook = new RunGitHook({ settings: gitSettings(), kv: kv() })
    await hook.begin('main', '')
    expect((await hook.end('main', 'x')).results).toEqual([])
  })
})

describe('a project chat turn', () => {
  const READY: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false }

  async function turn(files: Record<string, string>): Promise<{ root: string; bare: string; notices: string[] }> {
    const { root, bare } = repo()
    const writer: Tool = {
      spec: { name: 'write_note', description: 'Write a file.', schema: schema(['path', 'text'], {}) },
      run: async (input) => {
        mkdirSync(dirname(String(input['path'])), { recursive: true })
        writeFileSync(String(input['path']), String(input['text']))
        return 'written'
      },
    }
    const calls = Object.entries(files).map(([path, text]) => ({ name: 'write_note', input: { path: join(root, path), text } }))
    let step = 0
    const fake = await startFakeAi(() => {
      step += 1
      return step === 1 ? { toolCalls: calls } : { text: 'Done.' }
    })
    const db = new Store(':memory:')
    await db.upsert('project', { name: 'Proj', description: '', path: root, profile: '', hidden: false, chats: ['pc-git'] })
    const runner = new Runner({
      store: db,
      settings: settingsView({ ...DEFAULT_SETTINGS, ...READY }),
      secrets: secretsView('test-key'),
      tools: [...buildToolset({ store: db }), writer],
      providerFactory: (_current, key) => providerFor({ provider: 'openai', key, baseUrl: fake.url, allowHttp: true }),
      timeZone: 'UTC',
      classifier: null,
      git: new RunGitHook({ settings: gitSettings(), kv: kv() }),
    })
    try {
      await runner.send('Add the page', [], 'pc-git')
      const notices = (await db.list('chat_item')).filter((row) => row.kind === 'notice').map((row) => row.text)
      return { root, bare, notices }
    } finally {
      runner.dispose()
      await fake.close()
      db.close()
    }
  }

  it('its change is committed and pushed as WIP: <his message>, with no notice in the chat', async () => {
    const { bare, notices } = await turn({ 'src/page.ts': 'export const page = 1\n' })
    expect(remoteLog(bare).split('\n')[0]).toBe('WIP: Add the page')
    expect(notices.filter((n) => n.startsWith('Git:'))).toEqual([])
  })

  it('a secret it wrote stops the push and the chat is told in one line', async () => {
    const { root, bare, notices } = await turn({ 'src/page.ts': 'export const page = 1\n', 'src/keys.ts': `export const k = '${FAKE_AWS}'\n` })
    expect(remoteLog(bare)).toBe('first')
    expect(git(root, 'log', '-1', '--format=%s')).toBe('WIP: Add the page')
    const said = notices.filter((n) => n.startsWith('Git:'))
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('src/keys.ts (an AWS access key) and did not push')
    expect(said[0]).not.toContain(FAKE_AWS)
  })
})
