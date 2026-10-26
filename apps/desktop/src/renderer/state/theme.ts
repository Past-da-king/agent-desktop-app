import type { ThemePref } from '@agent/core'

import { ACCENTS, type AccentId } from '../../shared/brand'

/** The accents live in shared/brand.ts, the one source the renderer and the guide's overlay both read. */
export { ACCENTS, type AccentId }

export function isDarkNow(): boolean {
  const set = document.documentElement.dataset['theme']
  if (set === 'dark') return true
  if (set === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

let currentAccent: AccentId = 'iris'
let watching = false

/** `system` removes data-theme so the mockup's media query decides; light/dark pin it. */
export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement
  if (pref === 'system') delete root.dataset['theme']
  else root.dataset['theme'] = pref
  applyAccent(currentAccent)
}

export function applyAccent(id: string): void {
  const accent = ACCENTS.find((item) => item.id === id) ?? ACCENTS[0]
  if (!accent) return
  currentAccent = accent.id
  const root = document.documentElement
  const keys = ['--primary', '--on-primary', '--pc', '--on-pc']
  if (accent.id === 'iris') {
    for (const key of keys) root.style.removeProperty(key)
    return
  }
  const values = isDarkNow() ? accent.dark : accent.light
  if (!values) return
  keys.forEach((key, index) => root.style.setProperty(key, values[index] ?? ''))
}

export function startThemeWatcher(): void {
  if (watching) return
  watching = true
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyAccent(currentAccent))
}

export function accentLabel(id: string): string {
  return ACCENTS.find((item) => item.id === id)?.label ?? 'Iris'
}
