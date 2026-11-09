/**
 * Set-up pages follow-ups (9 Nov 2026): the projects area of the rail always keeps one row, Settings can be opened at
 * a section, the onboarding hero never names a fixed person, and the dead "Sign in with your phone" panel is gone.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { RAIL_BOX_PAD, RAIL_PAD_SMALL, RAIL_TILE_SMALL, fitRail, railMinHeight } from '../src/renderer/lib/projects'
import { requestSettingsSection, takeSettingsSection } from '../src/renderer/lib/settings-jump'
import { heroReply } from '../src/renderer/state/onboarding'

const read = (file: string): string => fs.readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8')

describe('the rail keeps a row of projects beside pinned apps', () => {
  it('asks for one row of small tiles with their names', () => {
    expect(railMinHeight(18)).toBe(RAIL_PAD_SMALL + RAIL_TILE_SMALL + 18 + RAIL_BOX_PAD)
    expect(railMinHeight(0)).toBe(RAIL_PAD_SMALL + RAIL_TILE_SMALL + RAIL_BOX_PAD)
    expect(railMinHeight(-5)).toBe(railMinHeight(0))
  })

  it('that least room always shows projects, never nothing', () => {
    for (const extra of [0, 16, 18, 20, 24]) {
      // What the rail measures: its height less its own padding.
      const room = railMinHeight(extra) - RAIL_BOX_PAD
      const expanded = fitRail({ room, cols: 3, gap: 6, extra }, 5)
      expect(expanded.none).toBe(false)
      expect(expanded.show).toBe(2)
      const collapsed = fitRail({ room: railMinHeight(0) - RAIL_BOX_PAD, cols: 1, gap: 6, extra: 0 }, 5)
      expect(collapsed.none).toBe(false)
    }
  })

  it('the rail uses it as the projects area minimum, with no way down to zero', () => {
    const rail = read('shell/Rail.tsx')
    expect(rail).toMatch(/minHeight: railMinHeight\(/)
    expect(rail).not.toMatch(/minHeight: header && projects\.length > 0 \? 0/)
  })
})

describe('opening Settings at a section', () => {
  it('is taken once', () => {
    expect(takeSettingsSection()).toBeNull()
    requestSettingsSection('privacy')
    expect(takeSettingsSection()).toBe('privacy')
    expect(takeSettingsSection()).toBeNull()
  })

  it('Connections asks for the folders section and Settings takes it', () => {
    expect(read('views/Connections.tsx')).toMatch(/requestSettingsSection\('privacy'\)/)
    expect(read('views/Settings.tsx')).toMatch(/takeSettingsSection\(\)/)
  })
})

describe('the onboarding hero', () => {
  it('uses the first name when known and no name otherwise', () => {
    expect(heroReply('')).toBe('On it.')
    expect(heroReply('   ')).toBe('On it.')
    expect(heroReply('Lerato Mokoena')).toBe('On it, Lerato.')
  })

  it('has no fixed name and no dead phone sign-in panel', () => {
    expect(read('onboarding/OnboardingLayout.tsx')).not.toMatch(/On it, Sam/)
    expect(read('onboarding/SignIn.tsx')).not.toMatch(/Sign in with your phone|Coming soon/)
  })
})

describe('failed loads say so', () => {
  it('the vault asking rules and the learned apps both offer Try again', () => {
    expect(read('views/Vault.tsx')).toMatch(/When the vault asks you could not be read/)
    expect(read('views/ConnectedApps.tsx')).toMatch(/Your learned apps could not be read/)
  })
})
