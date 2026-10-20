/**
 * Small helpers shared by the M6a tests: a fake ToolContext, a settings view and a secrets view.
 * Nothing here touches Electron, and nothing is mocked that could be run for real.
 */
import { DEFAULT_SETTINGS, type Settings, type Tool, type ToolContext } from '@agent/core'

import type { SecretsView, SettingsView } from '../src/main/runtime/runner'

export function testContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentLabel: 'test',
    activity: async () => 0,
    updateActivity: async () => undefined,
    ask: async () => null,
    approve: async () => false,
    notify: async () => undefined,
    signal: new AbortController().signal,
    ...overrides,
  }
}

export function toolNamed(tools: Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.spec.name === name)
  if (tool === undefined) throw new Error(`no tool called ${name}`)
  return tool
}

export function settingsView(patch: Partial<Settings> = {}): SettingsView {
  return {
    get() {
      return { ...DEFAULT_SETTINGS, grantedFolders: [], ...patch }
    },
  }
}

export function secretsView(key: string | null = 'test-key'): SecretsView {
  return {
    get(name: string) {
      return name === 'apiKey' ? key : null
    },
  }
}
