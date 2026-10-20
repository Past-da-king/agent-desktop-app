import { DEFAULT_SETTINGS, type Settings } from '@agent/core'
import { create } from 'zustand'

import { agent } from '../bridge'
import { applyAccent, applyTheme, startThemeWatcher } from './theme'

interface SettingsState {
  settings: Settings | null
  ready: boolean
  error: string | null
  load: () => Promise<void>
  save: (patch: Partial<Settings>) => Promise<Settings>
}

let subscribed = false

function apply(next: Settings): void {
  startThemeWatcher()
  applyTheme(next.theme)
  applyAccent(next.accent)
}

function subscribeOnce(): void {
  if (subscribed) return
  subscribed = true
  agent.settings.onChanged((next) => {
    apply(next)
    useSettings.setState({ settings: next, ready: true })
  })
}

export const useSettings = create<SettingsState>((set) => ({
  settings: null,
  ready: false,
  error: null,

  load: async () => {
    subscribeOnce()
    try {
      const next = await agent.settings.get()
      apply(next)
      set({ settings: next, ready: true, error: null })
    } catch (error) {
      apply(DEFAULT_SETTINGS)
      set({
        settings: { ...DEFAULT_SETTINGS },
        ready: true,
        error: error instanceof Error ? error.message : 'Settings could not be read.',
      })
    }
  },

  save: async (patch) => {
    const next = await agent.settings.save(patch)
    apply(next)
    set({ settings: next, ready: true })
    return next
  },
}))

export function useSettingsReady(): boolean {
  return useSettings((state) => state.ready)
}
