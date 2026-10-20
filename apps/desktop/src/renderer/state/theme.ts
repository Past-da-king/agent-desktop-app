import type { ThemePref } from '@agent/core'

export type AccentId =
  | 'iris'
  | 'ocean'
  | 'teal'
  | 'forest'
  | 'ember'
  | 'rose'
  | 'violet'
  | 'magenta'

interface Accent {
  id: AccentId
  label: string
  swatch: string
  light?: [string, string, string, string]
  dark?: [string, string, string, string]
}

/** Hand-tuned in the phone app, copied from the mockup's `ACC`. Iris is the token default. */
export const ACCENTS: Accent[] = [
  { id: 'iris', label: 'Iris', swatch: '#4A3FD1' },
  {
    id: 'ocean',
    label: 'Ocean',
    swatch: '#0B5FC9',
    light: ['#0B5FC9', '#F7FAFF', '#D6E4FF', '#001B3F'],
    dark: ['#A9C7FF', '#003064', '#004A99', '#D6E4FF'],
  },
  {
    id: 'teal',
    label: 'Teal',
    swatch: '#00696B',
    light: ['#00696B', '#F2FFFE', '#B9F0EE', '#002020'],
    dark: ['#7FD6D4', '#003737', '#004F50', '#B9F0EE'],
  },
  {
    id: 'forest',
    label: 'Forest',
    swatch: '#2E6A2F',
    light: ['#2E6A2F', '#F5FFF0', '#C6EFBC', '#032105'],
    dark: ['#9CD89A', '#0A390D', '#1B5220', '#C6EFBC'],
  },
  {
    id: 'ember',
    label: 'Ember',
    swatch: '#B0410C',
    light: ['#B0410C', '#FFF8F5', '#FFDBCB', '#390C00'],
    dark: ['#FFB591', '#5A1C00', '#853000', '#FFDBCB'],
  },
  {
    id: 'rose',
    label: 'Rose',
    swatch: '#B0255E',
    light: ['#B0255E', '#FFF7F8', '#FFD9E2', '#3E001D'],
    dark: ['#FFB1C8', '#650033', '#8E0D48', '#FFD9E2'],
  },
  {
    id: 'violet',
    label: 'Violet',
    swatch: '#7A2BF0',
    light: ['#7A2BF0', '#FCF8FF', '#EADDFF', '#25005A'],
    dark: ['#B98AFF', '#25005A', '#5A00C6', '#EADDFF'],
  },
  {
    id: 'magenta',
    label: 'Magenta',
    swatch: '#D6008A',
    light: ['#D6008A', '#FFF7F9', '#FFD8EA', '#3D0026'],
    dark: ['#FF6BC1', '#3D0026', '#8F005B', '#FFD8EA'],
  },
]

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
