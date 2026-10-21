import type { ChatItem } from '@agent/core'

import type { RunRecord } from '../../shared/run-record'

/**
 * The demo thread's commands (?demo=1): a step where the agent ran a shell command, a failing test run with long
 * output and stderr, a file read, some Python and a file write, then one command on its own. Made-up project.
 */

const CWD = 'C:\\Users\\sam\\projects\\shop'

const TEST_LOG = [
  '> shop@1.4.0 test',
  '> vitest run',
  '',
  ' RUN  v4.1.12 C:/Users/sam/projects/shop',
  '',
  ...Array.from({ length: 46 }, (_, i) => ` ✓ src/${['catalog', 'search', 'checkout', 'orders', 'account', 'stock'][i % 6]}/case-${String(i + 1).padStart(2, '0')}.test.ts (${(i * 7) % 40 + 3} tests) ${(i * 13) % 90 + 8}ms`),
  ' ✗ src/cart/total.test.ts > cart total > rounds to two decimals',
  '   AssertionError: expected 299.99000000000004 to be 299.99',
  '',
  ' Test Files  1 failed | 46 passed (47)',
  '      Tests  1 failed | 911 passed (912)',
  '   Duration  37.84s',
].join('\n')

const TEST_ERR = [
  'FAIL  src/cart/total.test.ts > cart total > rounds to two decimals',
  'AssertionError: expected 299.99000000000004 to be 299.99',
  '  at src/cart/total.test.ts:18:32',
  '',
  'npm ERR! Test failed.  See above for more details.',
].join('\n')

const CART = `export function cartTotal(lines: Line[]): number {
  return lines.reduce((sum, line) => sum + line.price * line.qty, 0)
}
`

const PY = `prices = [99.99, 100.0, 100.0]
total = sum(prices)
print("raw", total)
print("rounded", round(total, 2))`

const FIX = `export function cartTotal(lines: Line[]): number {
  const cents = lines.reduce((sum, line) => sum + Math.round(line.price * 100) * line.qty, 0)
  return cents / 100
}
`

function step(id: string, at: number, tool: string, summary: string, run: RunRecord): ChatItem {
  return {
    id,
    createdAt: at,
    kind: 'activity',
    text: summary,
    meta: JSON.stringify({ tool, status: run.state === 'running' ? 'running' : 'done', summary, run }),
  }
}

export function runsDemo(now: number): ChatItem[] {
  const at = (s: number): number => now - 44_000 + s * 400
  return [
    { id: 'rn1', createdAt: at(0), kind: 'user', text: 'Why are the shop tests failing on my laptop?', meta: '{}' },
    {
      id: 'rn2',
      createdAt: at(1),
      kind: 'approval',
      text: 'Run: git status --short',
      meta: JSON.stringify({ summary: 'Run: git status --short', details: '', decision: 'approve', scope: 'computer' }),
    },
    step('rn3', at(2), 'shell_run', 'Ran git status --short', {
      kind: 'shell',
      input: 'git status --short',
      label: 'PowerShell 7',
      cwd: CWD,
      stdout: ' M src/cart/total.ts\n M src/cart/total.test.ts\n?? notes/rounding.md\n',
      stderr: '',
      exitCode: 0,
      ms: 312,
      state: 'ok',
      trimmed: false,
    }),
    step('rn4', at(3), 'shell_run', 'Ran npm test -- --run --reporter=verbose', {
      kind: 'shell',
      input: 'npm test -- --run --reporter=verbose --pool=threads --maxWorkers=4 src/',
      label: 'PowerShell 7',
      cwd: CWD,
      stdout: TEST_LOG,
      stderr: TEST_ERR,
      exitCode: 1,
      ms: 38_420,
      waitedMs: 252_000,
      state: 'failed',
      trimmed: false,
    }),
    step('rn5', at(4), 'files_read', 'Read total.ts', {
      kind: 'file',
      input: `${CWD}\\src\\cart\\total.ts`,
      label: 'Read',
      stdout: CART,
      stderr: '',
      exitCode: null,
      ms: 9,
      state: 'ok',
      trimmed: false,
    }),
    step('rn6', at(5), 'run_code', 'Ran Python code', {
      kind: 'code',
      input: PY,
      label: 'python',
      cwd: 'C:\\Users\\sam\\AppData\\Local\\Temp\\agent-code-k2Jd9a',
      stdout: 'raw 299.99000000000004\nrounded 299.99\n',
      stderr: '',
      exitCode: 0,
      ms: 146,
      state: 'ok',
      trimmed: false,
    }),
    step('rn7', at(6), 'files_write', 'Wrote total.ts', {
      kind: 'file',
      input: `${CWD}\\src\\cart\\total.ts`,
      label: 'Write',
      stdout: FIX,
      stderr: '',
      exitCode: null,
      ms: 14,
      state: 'ok',
      trimmed: false,
      note: `Wrote ${FIX.length} characters to ${CWD}\\src\\cart\\total.ts.`,
    }),
    {
      id: 'rn8',
      createdAt: at(7),
      kind: 'agent',
      text: 'One test failed: the cart total adds prices as decimals, so R99.99 + R100 + R100 came out as 299.99000000000004. I changed `cartTotal` to add whole cents. Want me to run the tests again and push?',
      meta: '{}',
    },
    { id: 'rn9', createdAt: at(8), kind: 'user', text: 'Yes, run them and push', meta: '{}' },
    step('rn10', at(9), 'shell_run', 'Ran npm test -- --run && git push', {
      kind: 'shell',
      input: 'npm test -- --run && git commit -am "Add cart totals in whole cents" && git push https://sam:[redacted]@git.example.com/sam/shop.git',
      label: 'PowerShell 7',
      cwd: CWD,
      stdout: ' Test Files  47 passed (47)\n      Tests  912 passed (912)\n[fix/cart-cents 4e1b2c9] Add cart totals in whole cents\n 2 files changed, 6 insertions(+), 2 deletions(-)\n',
      stderr: 'To git.example.com:sam/shop.git\n   9a0f3d1..4e1b2c9  fix/cart-cents -> fix/cart-cents\n',
      exitCode: 0,
      ms: 41_870,
      state: 'ok',
      trimmed: false,
    }),
    { id: 'rn11', createdAt: at(10), kind: 'agent', text: 'All 912 tests pass and the fix is pushed to fix/cart-cents.', meta: '{}' },
  ]
}
