/**
 * One shell policy (Settings, This computer: always / ask / never) decides what every plan engine may do.
 * Bug of 23 Nov 2026: a Codex helper on Run without asking ran in workspace-write, so on Windows its sandbox refused
 * WSL (E_ACCESSDENIED, \\wsl.localhost paths) and ssh, while Claude helpers on the same setting reached everything.
 */
import { describe, expect, it } from 'vitest'

import { codexSettings } from '../src/main/runtime/cli-agent'
import { claudeLaunch, codexLaunch, engineAccess, enginePolicy, type ShellPolicy } from '../src/main/runtime/engine-policy'
import { sdkPermission } from '../src/main/runtime/sdk-permissions'

const MCP = { url: 'http://127.0.0.1:1/mcp', token: 't' }
const POLICIES: ShellPolicy[] = ['always', 'ask', 'never']

describe('the shell policy maps to every engine from one place', () => {
  it('only Run without asking frees the engines', () => {
    expect(engineAccess('always')).toBe('free')
    expect(engineAccess('ask')).toBe('asked')
    expect(engineAccess('never')).toBe('asked')
  })

  it('Codex, always: no sandbox, never asks, network on, on every platform', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const launch = codexLaunch('free', platform)
      expect(launch.sandboxMode).toBe('danger-full-access')
      expect(launch.approvalPolicy).toBe('never')
      expect(launch.networkAccessEnabled).toBe(true)
      expect(launch.ownShell).toBe(true)
      // No Windows sandbox setting at all: nothing is sandboxed, so nothing can refuse wsl.exe or ssh.
      expect(launch.windowsSandbox).toBeUndefined()
    }
  })

  it('Codex, ask or never: the restriction stays (read-only, no network, own shell off)', () => {
    for (const policy of ['ask', 'never'] as const) {
      const launch = codexLaunch(engineAccess(policy), 'win32')
      expect(launch.sandboxMode).toBe('read-only')
      expect(launch.approvalPolicy).toBe('never')
      expect(launch.networkAccessEnabled).toBe(false)
      expect(launch.ownShell).toBe(false)
    }
  })

  it('codexSettings follows the policy: thread options and config', () => {
    for (const policy of POLICIES) {
      const access = engineAccess(policy)
      const { thread, config } = codexSettings({ workDir: 'C:\\w', folder: 'C:\\p', access, mcp: MCP }, 'win32')
      const features = config['features'] as Record<string, unknown>
      if (policy === 'always') {
        expect(thread.sandboxMode).toBe('danger-full-access')
        expect(thread.networkAccessEnabled).toBe(true)
        expect(config['windows']).toBeUndefined()
        expect(features['shell_tool']).toBeUndefined()
      } else {
        expect(thread.sandboxMode).toBe('read-only')
        expect(thread.networkAccessEnabled).toBe(false)
        expect(features['shell_tool']).toBe(false)
        expect(features['unified_exec']).toBe(false)
      }
      expect(thread.approvalPolicy).toBe('never')
    }
  })

  it('Claude: the app decides every tool call, whatever the policy', () => {
    for (const policy of POLICIES) {
      const launch = claudeLaunch(engineAccess(policy))
      expect(launch.permissionMode).toBe('default')
      expect(launch.decidedByApp).toBe(true)
    }
    expect(claudeLaunch('free').shellFree).toBe(true)
    expect(claudeLaunch('asked').shellFree).toBe(false)
  })

  it("Claude's gate agrees: always allows a command anywhere, never refuses, ask asks", async () => {
    const asked: string[] = []
    const gate = (shell: ShellPolicy) =>
      sdkPermission({
        settings: () => ({ shell, grantedFolders: [] }) as never,
        approve: async (title: string) => {
          asked.push(title)
          return false
        },
      } as never)
    expect((await gate('always')('Bash', { command: 'wsl -d Ubuntu -- ssh impetix hostname' })).allow).toBe(true)
    expect((await gate('never')('Bash', { command: 'ls' })).allow).toBe(false)
    expect(asked).toEqual([])
    expect((await gate('ask')('Bash', { command: 'ls' })).allow).toBe(false)
    expect(asked).toHaveLength(1)
  })

  it('enginePolicy gives one answer per engine for each policy', () => {
    for (const policy of POLICIES) {
      const result = enginePolicy(policy, 'win32')
      expect(result.access).toBe(engineAccess(policy))
      expect(result.codex).toEqual(codexLaunch(result.access, 'win32'))
      expect(result.claude).toEqual(claudeLaunch(result.access))
    }
  })
})
