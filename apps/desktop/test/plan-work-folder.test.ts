/**
 * A plan run (Claude or Codex) works in the project's folder, with the access the person chose, and helpers on the
 * Codex path are the app's own, not Codex sub-agents that die with the turn (bug of 23 Oct 2026: a Codex project chat
 * ran read-only in its private folder, and every helper it started was killed the moment its turn ended).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { MAIN_CHAT } from '@agent/core'

import { codexRules, codexSettings, engineFolders } from '../src/main/runtime/cli-agent'
import { projectFolderOf, usableFolder } from '../src/main/runtime/work-folder'

const temp: string[] = []
afterEach(async () => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-work-'))
  temp.push(dir)
  return dir
}

const MCP = { url: 'http://127.0.0.1:1/mcp', token: 't' }

describe('Codex runs in the project folder with the access the person chose', () => {
  it('Run without asking: workspace-write on the project folder, its private folder added', () => {
    const { thread, config } = codexSettings({ workDir: 'C:\\data\\cli\\codex\\chat_p1', folder: 'C:\\projects\\cms', access: 'free', mcp: MCP }, 'win32')
    expect(thread.workingDirectory).toBe('C:\\projects\\cms')
    expect(thread.additionalDirectories).toEqual(['C:\\data\\cli\\codex\\chat_p1'])
    expect(thread.sandboxMode).toBe('workspace-write')
    expect(thread.networkAccessEnabled).toBe(true)
    expect(thread.skipGitRepoCheck).toBe(true)
    // The default Windows sandbox refuses every write unless an administrator set it up.
    expect(config['windows']).toEqual({ sandbox: 'unelevated' })
    expect(codexSettings({ workDir: '/w', folder: '/p', access: 'free', mcp: MCP }, 'linux').config['windows']).toBeUndefined()
    expect(codexSettings({ workDir: '/w', folder: '/p', access: 'asked', mcp: MCP }, 'win32').config['windows']).toBeUndefined()
  })

  it('the app tools are attached to every turn and declared to the model up front, not deferred behind tool search', () => {
    for (const access of ['free', 'asked'] as const) {
      for (const folder of [undefined, '/projects/cms']) {
        const { config } = codexSettings({ workDir: '/w', ...(folder === undefined ? {} : { folder }), access, mcp: MCP })
        const agent = (config['mcp_servers'] as Record<string, Record<string, unknown>>)['agent']
        expect(agent?.['url']).toBe(MCP.url)
        expect(agent?.['bearer_token_env_var']).toBe('AGENT_MCP_TOKEN')
        expect(agent?.['omit_tools_from']).toEqual(['deferred'])
        expect(agent?.['default_tools_approval_mode']).toBe('approve')
      }
    }
  })

  it('asking: still in the project folder, its own shell off so every action goes through the app tools', () => {
    const { thread, config } = codexSettings({ workDir: '/data/chat_p1', folder: '/projects/cms', access: 'asked', mcp: MCP })
    expect(thread.workingDirectory).toBe('/projects/cms')
    expect(thread.sandboxMode).toBe('read-only')
    expect(thread.networkAccessEnabled).toBe(false)
    expect((config['features'] as Record<string, unknown>)['shell_tool']).toBe(false)
    expect((config['features'] as Record<string, unknown>)['unified_exec']).toBe(false)
  })

  it('Codex sub-agents are off on every turn, and nothing from the person’s own Codex setup joins in', () => {
    for (const access of ['free', 'asked'] as const) {
      const { config } = codexSettings({ workDir: '/w', access, mcp: MCP })
      expect(config['agents']).toEqual({ enabled: false })
      const features = config['features'] as Record<string, unknown>
      expect(features['multi_agent_v2']).toBe(false)
      expect(features['apps']).toBe(false)
      expect(features['plugins']).toBe(false)
      expect(config['project_doc_max_bytes']).toBe(0)
      expect((config['mcp_servers'] as Record<string, Record<string, unknown>>)['agent']?.['url']).toBe(MCP.url)
    }
  })

  it('with no project, the chat’s own folder', () => {
    expect(engineFolders({ workDir: '/w' })).toEqual({ cwd: '/w', extra: [] })
    expect(codexSettings({ workDir: '/w', access: 'free', mcp: MCP }).thread.workingDirectory).toBe('/w')
    expect(codexSettings({ workDir: '/w', access: 'free', mcp: MCP }).thread.additionalDirectories).toBeUndefined()
  })

  it('the agent is told where it works and that the sandbox is not a blocker', () => {
    expect(codexRules({ workDir: '/w', folder: '/projects/cms', access: 'free' })).toContain('/projects/cms')
    expect(codexRules({ workDir: '/w', folder: '/projects/cms', access: 'asked' })).toContain('shell_run')
    // Codex names the app's tools mcp__agent__<name>: the agent is told so, and that helpers are delegate.
    expect(codexRules({ workDir: '/w', access: 'free' })).toContain('mcp__agent__delegate')
  })
})

describe('the folder a chat works in', () => {
  it('is its project’s folder, and only when that folder exists', () => {
    const projects = [{ chats: ['p1', 'p2'], path: ' C:\\projects\\cms ' }, { chats: ['p3'], path: '' }]
    expect(projectFolderOf(projects, 'p2')).toBe('C:\\projects\\cms')
    expect(projectFolderOf(projects, 'p3')).toBe('')
    expect(projectFolderOf(projects, MAIN_CHAT)).toBe('')
    const real = folder()
    expect(usableFolder(real)).toBe(real)
    expect(usableFolder(join(real, 'missing'))).toBeUndefined()
    expect(usableFolder('')).toBeUndefined()
  })
})

