/**
 * "Open Settings at this section": a page that sends the person to Settings names the section first, and Settings
 * takes it once when it opens. One-shot, so a later plain visit to Settings starts at the top as usual.
 */
let wanted: string | null = null

export function requestSettingsSection(id: string): void {
  wanted = id
}

/** The section asked for, once; null when nothing was asked. */
export function takeSettingsSection(): string | null {
  const id = wanted
  wanted = null
  return id
}
