/**
 * What the computer remembers about each linked device's data use: its prefs (`device.prefs`) and the helper cards it
 * was last sent. Kept per device id, dropped when its last connection ends, so a device that reconnects starts from
 * nothing (and says its prefs again). A device with no entry here is a legacy one and hears everything as before.
 */
import { LEGACY_PREFS, parsePrefs, type CardsMemory, type DevicePrefs } from '../../shared/device-feed'

const prefs = new Map<string, DevicePrefs>()
const cards = new Map<string, CardsMemory>()

export const feedState = {
  prefsOf(deviceId: string): DevicePrefs {
    return prefs.get(deviceId) ?? LEGACY_PREFS
  },
  setPrefs(deviceId: string, raw: unknown): DevicePrefs {
    const next = parsePrefs(raw)
    const before = prefs.get(deviceId)
    prefs.set(deviceId, next)
    // Leaving the helpers screen (or going metered) forgets what was sent: the next time it asks it gets the whole list.
    if (before === undefined || (next.metered && !next.helpers)) cards.delete(deviceId)
    return next
  },
  cardsHeld(deviceId: string): CardsMemory | undefined {
    return cards.get(deviceId)
  },
  setCards(deviceId: string, held: CardsMemory | null): void {
    if (held === null) cards.delete(deviceId)
    else cards.set(deviceId, held)
  },
  clear(deviceId: string): void {
    prefs.delete(deviceId)
    cards.delete(deviceId)
  },
  /** Tests only. */
  reset(): void {
    prefs.clear()
    cards.clear()
  },
}
