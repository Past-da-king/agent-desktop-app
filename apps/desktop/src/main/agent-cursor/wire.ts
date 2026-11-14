/**
 * Puts the screen tools together for the app: the helper's calls, the picture folder, the takers memory on disk, the
 * input lock (real input, off unless he allowed it in Settings), and the agent cursor. Electron stays out of this file:
 * index.ts passes the toast and the pixel conversion.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ScreenControl, memoryTakers, type ExtraRung } from './control'
import { agentCursor } from './cursor'
import { InputLock } from './input-lock'
import { lockInjector, lockNotice, lockPresence, type LockHelper, type ShowNotice } from './lock-host'

export interface WireDeps {
  helper: LockHelper
  /** A folder for pictures (created when needed). */
  picturesDir: string
  /** Where the rungs known to take his focus are remembered. */
  takersFile: string
  settings: () => { agentRealInput?: boolean; inputLockIdleSeconds?: number }
  showNotice: ShowNotice
  /** Physical screen pixels (the helper's) to the DIPs the cursor overlay uses. */
  toDip: (point: { x: number; y: number }) => { x: number; y: number }
  /** The lead's rungs. */
  cdp?: ExtraRung
  desktop?: ExtraRung
  now?: () => number
}

function loadTakers(file: string): Array<[string, string, string]> {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return (Array.isArray(raw) ? raw : []).filter((row): row is [string, string, string] => Array.isArray(row) && row.length === 3 && row.every((cell) => typeof cell === 'string'))
  } catch {
    return []
  }
}

export function createScreenControl(deps: WireDeps): ScreenControl {
  let pictures = 0
  const lock = new InputLock({
    settings: () => ({ inputLockIdleSeconds: deps.settings().inputLockIdleSeconds ?? 10 }),
    presence: lockPresence(deps.helper),
    notice: lockNotice(deps.showNotice),
    injector: lockInjector(deps.helper),
  })
  return new ScreenControl({
    call: (op, args, timeoutMs) => deps.helper.call(op, args, timeoutMs),
    savePicture: async (png) => {
      mkdirSync(deps.picturesDir, { recursive: true })
      const path = join(deps.picturesDir, 'screen-' + String((deps.now ?? Date.now)()) + '-' + String(++pictures % 1000) + '.png')
      writeFileSync(path, png)
      return path
    },
    takers: memoryTakers(loadTakers(deps.takersFile), (all) => {
      try {
        writeFileSync(deps.takersFile, JSON.stringify(all))
      } catch {
        // Not remembered this time; it is learned again on the next steal.
      }
    }),
    lock,
    realInputAllowed: () => deps.settings().agentRealInput === true,
    ...(deps.cdp === undefined ? {} : { cdp: deps.cdp }),
    ...(deps.desktop === undefined ? {} : { desktop: deps.desktop }),
    cursor: {
      show: (id, spec) => {
        const at = spec.at === undefined ? undefined : deps.toDip(spec.at)
        return agentCursor.show({ owner: id, ...(spec.label === undefined ? {} : { label: spec.label }), ...(at === undefined ? {} : { rect: { x: at.x, y: at.y, width: 0, height: 0 } }) })
      },
      click: (id) => agentCursor.click(id),
    },
  })
}
