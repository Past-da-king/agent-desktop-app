import vm from 'node:vm'

import { describe, expect, it } from 'vitest'

import { PRESENCE_SCRIPT } from '../src/main/browser/presence'

/** A bare page global: an empty window.chrome and a window narrower than its page, as measured on 0.2.22. */
function page(): Record<string, unknown> {
  const g: Record<string, unknown> = { performance: { timeOrigin: 1_000_000, now: () => 50, getEntriesByType: () => [] }, innerWidth: 1440, innerHeight: 1346, chrome: {} }
  g['window'] = g
  Object.defineProperty(g, 'outerWidth', { get: () => 1364, set: () => undefined, configurable: true, enumerable: true })
  Object.defineProperty(g, 'outerHeight', { get: () => 763, set: () => undefined, configurable: true, enumerable: true })
  return vm.createContext(g)
}

describe('how a page sees the agent browser', () => {
  it('has the window.chrome a real Chrome has, with native-looking functions', () => {
    const g = page()
    vm.runInContext(PRESENCE_SCRIPT, g)
    expect(vm.runInContext('Object.keys(window.chrome)', g)).toEqual(['app', 'csi', 'loadTimes'])
    expect(vm.runInContext('window.chrome.csi.toString()', g)).toBe('function csi() { [native code] }')
    expect(vm.runInContext('typeof window.chrome.loadTimes().requestTime', g)).toBe('number')
    expect(vm.runInContext('window.chrome.app.isInstalled', g)).toBe(false)
    // Ordinary functions still print their own source.
    expect(vm.runInContext('(function mine() { return 1 }).toString()', g)).toBe('function mine() { return 1 }')
  })

  it('never reports a window smaller than its page', () => {
    const g = page()
    vm.runInContext(PRESENCE_SCRIPT, g)
    expect(vm.runInContext('[outerWidth, outerHeight]', g)).toEqual([1440, 1431])
  })

  it('leaves a real chrome object alone and survives a page that froze window', () => {
    const g = page()
    g['chrome'] = { app: 'kept', csi: 'kept', loadTimes: 'kept' }
    vm.runInContext(PRESENCE_SCRIPT, g)
    expect(vm.runInContext('window.chrome.app', g)).toBe('kept')
    const frozen = vm.createContext(Object.freeze({ window: null, performance: {} }))
    expect(() => vm.runInContext(PRESENCE_SCRIPT, frozen)).not.toThrow()
  })
})
