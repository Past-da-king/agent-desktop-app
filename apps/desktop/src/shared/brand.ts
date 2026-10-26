/**
 * The app's brand look as data (26 Oct 2026): the accent palettes, the surfaces, the font and the radius the renderer's
 * tokens.css is made of, in ONE place, for anything the app draws outside its own window's CSS (the guided
 * click-through's ring and label on other sites' pages). The renderer's accent picker reads ACCENTS from here too, and
 * test/brand-tokens.test.ts keeps tokens.css and this file the same, so an overlay never carries a colour of its own.
 */

export type AccentId = 'iris' | 'ocean' | 'teal' | 'forest' | 'ember' | 'rose' | 'violet' | 'magenta'

/** [primary, on-primary, primary container, on-primary container]: the four tokens an accent sets. */
export type AccentTones = [string, string, string, string]

export interface Accent {
  id: AccentId
  label: string
  swatch: string
  light?: AccentTones
  dark?: AccentTones
}

/** Iris is the token default (tokens.css :root), so the renderer leaves its four tokens to the stylesheet. */
export const IRIS: { light: AccentTones; dark: AccentTones } = {
  light: ['#4A3FD1', '#FBFAFF', '#E4E0FF', '#1C1466'],
  dark: ['#C3BBFF', '#241A7A', '#3A2FB0', '#E7E3FF'],
}

/** Hand-tuned in the phone app, copied from the mockup's `ACC`. */
export const ACCENTS: Accent[] = [
  { id: 'iris', label: 'Iris', swatch: '#4A3FD1' },
  { id: 'ocean', label: 'Ocean', swatch: '#0B5FC9', light: ['#0B5FC9', '#F7FAFF', '#D6E4FF', '#001B3F'], dark: ['#A9C7FF', '#003064', '#004A99', '#D6E4FF'] },
  { id: 'teal', label: 'Teal', swatch: '#00696B', light: ['#00696B', '#F2FFFE', '#B9F0EE', '#002020'], dark: ['#7FD6D4', '#003737', '#004F50', '#B9F0EE'] },
  { id: 'forest', label: 'Forest', swatch: '#2E6A2F', light: ['#2E6A2F', '#F5FFF0', '#C6EFBC', '#032105'], dark: ['#9CD89A', '#0A390D', '#1B5220', '#C6EFBC'] },
  { id: 'ember', label: 'Ember', swatch: '#B0410C', light: ['#B0410C', '#FFF8F5', '#FFDBCB', '#390C00'], dark: ['#FFB591', '#5A1C00', '#853000', '#FFDBCB'] },
  { id: 'rose', label: 'Rose', swatch: '#B0255E', light: ['#B0255E', '#FFF7F8', '#FFD9E2', '#3E001D'], dark: ['#FFB1C8', '#650033', '#8E0D48', '#FFD9E2'] },
  { id: 'violet', label: 'Violet', swatch: '#7A2BF0', light: ['#7A2BF0', '#FCF8FF', '#EADDFF', '#25005A'], dark: ['#B98AFF', '#25005A', '#5A00C6', '#EADDFF'] },
  { id: 'magenta', label: 'Magenta', swatch: '#D6008A', light: ['#D6008A', '#FFF7F9', '#FFD8EA', '#3D0026'], dark: ['#FF6BC1', '#3D0026', '#8F005B', '#FFD8EA'] },
]

/** The surface tokens an overlay uses, per theme (tokens.css). */
export interface Surfaces {
  bg: string
  onBg: string
  sc: string
  onSc: string
  sLowest: string
  sHigh: string
  outlineV: string
}

export const SURFACES: { light: Surfaces; dark: Surfaces } = {
  light: { bg: '#FAF8F4', onBg: '#1B1A1F', sc: '#E6E3F2', onSc: '#1D1B2B', sLowest: '#FEFDFB', sHigh: '#E9E7E2', outlineV: '#CAC6D2' },
  dark: { bg: '#131218', onBg: '#E9E7EE', sc: '#45435A', onSc: '#E6E3F2', sLowest: '#0E0D12', sHigh: '#292830', outlineV: '#47454F' },
}

/** tokens.css --font and --r-sm. */
export const BRAND_FONT = "'Roboto Flex Variable','Roboto Flex',Roboto,system-ui,'Segoe UI',sans-serif"
export const BRAND_RADIUS_SM = 12

export type ThemeChoice = 'system' | 'light' | 'dark'

/** Everything an overlay needs to look like the app, resolved for one theme and accent. */
export interface BrandLook {
  dark: boolean
  primary: string
  onPrimary: string
  pc: string
  onPc: string
  /** The label's card: the app's tooltip / card surface. */
  surface: string
  onSurface: string
  outline: string
  /** Tonal button (Skip), like the app's .btn.tonal. */
  tonal: string
  onTonal: string
  /** A thin edge that stands off the accent whatever the page under it is (light, dark or itself blue). */
  edge: string
  font: string
  radius: number
}

export function accentTones(accent: string | undefined, dark: boolean): AccentTones {
  const found = ACCENTS.find((item) => item.id === accent)
  const tones = found === undefined || found.id === 'iris' ? undefined : dark ? found.dark : found.light
  return tones ?? (dark ? IRIS.dark : IRIS.light)
}

/** The app's look for a theme setting and accent; `systemDark` is what the computer says when the setting is system. */
export function brandLook(options: { theme?: ThemeChoice | string; accent?: string; systemDark?: boolean } = {}): BrandLook {
  const dark = options.theme === 'dark' || (options.theme !== 'light' && options.systemDark === true)
  const [primary, onPrimary, pc, onPc] = accentTones(options.accent, dark)
  const s = dark ? SURFACES.dark : SURFACES.light
  return {
    dark,
    primary,
    onPrimary,
    pc,
    onPc,
    surface: dark ? s.sHigh : s.sLowest,
    onSurface: s.onBg,
    outline: s.outlineV,
    tonal: s.sc,
    onTonal: s.onSc,
    // A light accent (dark theme) gets the app's dark background as its edge; a deep accent (light theme) gets white.
    edge: dark ? s.bg : '#FFFFFF',
    font: BRAND_FONT,
    radius: BRAND_RADIUS_SM,
  }
}

/** #RRGGBB with an alpha, as rgba(), so a glow is the accent's own hue. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (m === null) return hex
  const n = Number.parseInt(m[1]!, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}
