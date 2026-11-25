import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { SyncClient } from '@agent/core'
import { Store } from '../src/main/db'
import { bootstrapPeerAuthority } from '../src/main/devices/replicate'
import { reviewableCall } from '../src/main/runtime/pr-gate-detect'
const cleanup: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn())
})
function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'pr-r9-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const pass = [
  'git status',
  'git diff --stat',
  'git log -5',
  'git pull --ff-only',
  'git commit -m "Fix GitHub link"',
  'git push origin feature/example',
  'git push -u origin HEAD:refs/heads/feat/example',
  'git push --force-with-lease origin feat/example',
  'git clone https://github.com/o/r && npm ci',
  'pip install git+https://github.com/o/r',
  'npm install gh-pages',
  'npm run build',
  'pnpm install',
  'pnpm test',
  '~/bin/build-slot npm run build',
  'ssh impetix "npm test"',
  'gh run list',
  'gh run view 4 --log-failed',
  'gh repo view',
  'gh release list',
  'gh workflow list',
  'gh search prs bug',
  'gh pr view 1 | head',
  'gh pr diff 1 > /tmp/change.diff',
  'gh pr view "$PR"',
  'gh pr list\ngh issue list',
  'gh api repos/o/r/pulls/1',
  'curl https://api.github.com/repos/o/r/releases',
  'curl https://github.com/o/r/archive/main.tar.gz | tar -tz',
  '# github.com/o/r\nnpm test',
  'echo "github.com"',
  'gh pr comment 1 --body "See github.com/o/r"',
  'gh pr ready 1 --undo',
  'gh pr review 1 --comment --body "Looks useful"',
  'gh pr create --draft --title "Feature" --body "First line\nSecond line"',
  'gh pr view 1 | Select-Object -First 1',
  'wsl --shutdown',
  'wsl --install',
  'wsl.exe -d Ubuntu -- npm test',
]
it.each(pass)('R9 everyday command passes: %s', (command) => {
  expect(reviewableCall('shell_run', { command })).toBe(false)
})
it.each([
  'gh pr ready 1',
  'gh pr merge 1',
  'gh pr merge 1 --auto',
  'gh pr review 1 --approve',
  'gh pr edit 1 --add-reviewer person',
  'gh pr create --title "Feature"',
  'gh pr comment 1 --body "Ready for review"',
  'gh issue comment 1 --body "Ready for review"',
  'gh api repos/o/r/pulls/1/merge -X PUT',
  'gh api repos/o/r/pulls/1/reviews -f event=APPROVE',
  'git push origin HEAD:main',
  'git push origin master',
  'git push --all origin',
])('R9 review action holds: %s', (command) =>
  expect(reviewableCall('shell_run', { command })).toBe(true),
)
it('R9 default and configured protected branches hold, feature branch and implicit feature push pass', () => {
  const cwd = folder()
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })
  git('init')
  git('symbolic-ref', 'HEAD', 'refs/heads/feature/work')
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
  git('config', 'prGate.protectedBranches', 'release/stable')
  for (const command of [
    'git push origin trunk',
    'git push origin HEAD:release/stable',
  ])
    expect(reviewableCall('shell_run', { command, cwd })).toBe(true)
  for (const command of ['git push origin feature/work', 'git push'])
    expect(reviewableCall('shell_run', { command, cwd })).toBe(false)
})
it.each(['python3', 'node'])(
  'R9 reads %s script files cooperatively',
  (exe) => {
    const cwd = folder(),
      file = exe === 'node' ? 'publish.js' : 'publish.py'
    const code =
      exe === 'node'
        ? 'fetch("https://api.github.com/repos/o/r/pulls/1/merge", {method: "PUT"})'
        : 'import requests\nrequests.put("https://api.github.com/repos/o/r/pulls/1/merge")'
    writeFileSync(join(cwd, file), code)
    expect(
      reviewableCall('shell_run', { command: `${exe} ${file}`, cwd }),
    ).toBe(true)
    writeFileSync(join(cwd, file), 'print("github.com")')
    expect(
      reviewableCall('shell_run', { command: `${exe} ${file}`, cwd }),
    ).toBe(false)
  },
)
it('R9 reset store recovers latest pinned authority without local stamps, then accepts the held page', async () => {
  const host = new Store(':memory:'),
    reset = new Store(':memory:')
  cleanup.push(
    () => host.close(),
    () => reset.close(),
  )
  await host.upsert('device', {
    id: host.deviceId,
    name: 'Host',
    fp: 'pinned',
    roles: ['brain'],
    urls: ['https://peer'],
    prGatePublicKey: 'old',
  })
  await host.upsert('device', { id: host.deviceId, prGatePublicKey: 'new' })
  const changes = host.changesAfter(0).changes
  const peer = {
    id: host.deviceId,
    name: 'Host',
    fp: 'pinned',
    urls: ['https://peer'],
  }
  const client = new SyncClient(
    'https://peer',
    'test-only-[vault:vercel-recovery-past952.token]',
  )
  vi.spyOn(client, 'pull').mockImplementation(async (since) => ({
    changes: since === 0 ? changes : [],
    cursor: changes.length,
  }))
  await expect(reset.applyRemote(changes, host.deviceId)).rejects.toThrow(
    'not bootstrapped',
  )
  await bootstrapPeerAuthority(reset, client, peer)
  expect(await reset.get('device', host.deviceId)).toMatchObject({
    prGatePublicKey: 'new',
  })
  expect(reset.changesAfter(0).changes.at(-1)?.stamp).toBe(
    changes.at(-1)?.stamp,
  )
  await expect(
    reset.applyRemote(changes, host.deviceId),
  ).resolves.toBeUndefined()
})
it('R9 mismatched pinned authority remains held without moving a normal pull cursor', async () => {
  const store = new Store(':memory:')
  cleanup.push(() => store.close())
  const client = new SyncClient(
    'https://peer',
    'test-only-[vault:vercel-recovery-past952.token]',
  )
  vi.spyOn(client, 'pull').mockResolvedValue({ changes: [], cursor: 0 })
  await expect(
    bootstrapPeerAuthority(store, client, {
      id: 'peer',
      name: 'Peer',
      fp: 'pin',
      urls: ['https://peer'],
    }),
  ).rejects.toThrow('not bootstrapped')
  expect(store.localValue('peer_pull:peer')).toBeNull()
})
