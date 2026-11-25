import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codeTools } from '../src/main/tools/code'
import { expect, it, vi } from 'vitest'
import { DeviceToolHost } from '../src/main/devices/device-tool-host'
import { testContext } from './support'
function fixture(run: () => Promise<string>, shared = () => true) {
  const tool = {
    spec: { name: 'shell_run', description: 'fixture', schema: {} },
    run,
  }
  return new DeviceToolHost({
    tools: () => [tool],
    context: (signal) => testContext({ signal }),
    shared: () => ({
      browser: true,
      files: true,
      notifications: true,
      approval: true,
      shell: shared(),
    }),
    inbox: '/tmp',
  })
}
const command = {
  kind: 'tool',
  id: 'same-command',
  tool: 'shell_run',
  args: { command: 'fixture' },
  chatId: 'project',
  deadlineMs: 1000,
}
it('shares an in-flight result and never repeats a completed command id', async () => {
  const run = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    return 'executed once'
  })
  const host = fixture(run)
  const replies = await Promise.all(
    Array.from({ length: 10 }, () => host.run(command)),
  )
  expect(run).toHaveBeenCalledTimes(1)
  expect(
    replies.every(
      (reply) => JSON.stringify(reply) === JSON.stringify(replies[0]),
    ),
  ).toBe(true)
  expect(await host.run(command)).toEqual(replies[0])
  expect(run).toHaveBeenCalledTimes(1)
})
it('refuses a reused command id with different payload bytes', async () => {
  const run = vi.fn(async () => 'executed once'),
    host = fixture(run)
  await host.run(command)
  const reply = await host.run({
    ...command,
    args: { command: 'different action' },
  })
  expect(reply.ok).toBe(false)
  expect(run).toHaveBeenCalledTimes(1)
})
it('does not retry failed effects or retain unbounded large replies', async () => {
  const failed = vi.fn(async () => {
      throw Error('fixture failure')
    }),
    host = fixture(failed)
  const first = await host.run(command)
  expect(await host.run(command)).toEqual(first)
  expect(failed).toHaveBeenCalledTimes(1)
  const large = vi.fn(async () => 'x'.repeat(300000)),
    other = fixture(large)
  expect((await other.run(command)).ok).toBe(true)
  const replay = await other.run(command)
  expect(JSON.stringify(replay).length).toBeLessThan(2000)
  expect(large).toHaveBeenCalledTimes(1)
})

it('does not return cached data after the sharing group is [vault:ls-alerts-test-webhook]', async () => {
  let allowed = true
  const run = vi.fn(async () => 'authorised result'),
    host = fixture(run, () => allowed)
  expect((await host.run(command)).ok).toBe(true)
  allowed = false
  const reply = await host.run(command)
  expect(reply.ok).toBe(false)
  expect(JSON.stringify(reply)).toContain('not shared')
  expect(run).toHaveBeenCalledTimes(1)
})

it('bounds the aggregate cached reply payload without repeating pruned actions', async () => {
  const run = vi.fn(async () => 'x'.repeat(100000)),
    host = fixture(run)
  for (let index = 0; index < 50; index++)
    await host.run({ ...command, id: 'retained-' + index })
  const old = await host.run({ ...command, id: 'retained-0' })
  expect(JSON.stringify(old).length).toBeLessThan(2000)
  expect(run).toHaveBeenCalledTimes(50)
})


it('coalesces remote retries of a real run_code file mutation', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'remote-code-replay-'))
  const file = join(scratch, 'effects.txt')
  const tools = codeTools({ tempRoot: scratch, settings: { get: () => ({ shell: 'always' }) } })
  const host = new DeviceToolHost({
    tools: () => tools,
    context: (signal) => testContext({ signal, shell: 'always' }),
    shared: () => ({ browser: true, files: true, notifications: true, approval: true, shell: true }),
    inbox: scratch,
  })
  const request = {
    ...command,
    id: 'run-code-mutation',
    tool: 'run_code',
    deadlineMs: 10_000,
    args: { language: 'javascript', code: `require('node:fs').appendFileSync(${JSON.stringify(file)}, 'effect\\n');console.log('done')` },
  }
  try {
    const replies = await Promise.all(Array.from({ length: 10 }, () => host.run(request)))
    expect(replies.every((reply) => reply.ok)).toBe(true)
    expect((await host.run(request)).ok).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('effect\n')
    expect((await host.run({ ...request, args: { ...request.args, code: request.args.code + ';console.log(2)' } })).ok).toBe(false)
    expect(await readFile(file, 'utf8')).toBe('effect\n')
  } finally { await rm(scratch, { recursive: true, force: true }) }
}, 30_000)
