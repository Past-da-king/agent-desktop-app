import vm from 'node:vm'

import { describe, expect, it } from 'vitest'

import { PRESENCE_SCRIPT } from '../src/main/browser/presence'

/** A bare page global: an empty window.chrome, as an Electron page has before any script of ours runs. */
function page(): Record<string, unknown> {
  const g: Record<string, unknown> = { performance: { timeOrigin: 1_000_000, now: () => 50, getEntriesByType: () => [] }, innerWidth: 1440, innerHeight: 1346, chrome: {} }
  g['window'] = g
  Object.defineProperty(g, 'outerWidth', { get: () => 1364, set: () => undefined, configurable: true, enumerable: true })
  Object.defineProperty(g, 'outerHeight', { get: () => 763, set: () => undefined, configurable: true, enumerable: true })
  return vm.createContext(g)
}

describe('how a page sees the agent browser', () => {
  it('has the window.chrome a real Chrome has, and never rewrites Function.prototype.toString', () => {
    const g = page()
    vm.runInContext(PRESENCE_SCRIPT, g)
    expect(vm.runInContext('Object.keys(window.chrome)', g)).toEqual(['app', 'csi', 'loadTimes'])
    expect(vm.runInContext('typeof window.chrome.loadTimes().requestTime', g)).toBe('number')
    expect(vm.runInContext('window.chrome.app.isInstalled', g)).toBe(false)
    // The one thing that must never happen: a native-code proxy over toString, which is a textbook bot tell.
    expect(vm.runInContext('Function.prototype.toString.toString()', g)).toBe('function toString() { [native code] }')
    expect(vm.runInContext('Function.prototype.toString === Function.prototype.toString', g)).toBe(true)
    expect(vm.runInContext('(function mine() { return 1 }).toString()', g)).toBe('function mine() { return 1 }')
  })

  it('leaves the window geometry exactly as the engine reports it', () => {
    const g = page()
    vm.runInContext(PRESENCE_SCRIPT, g)
    expect(vm.runInContext('[outerWidth, outerHeight, innerWidth, innerHeight]', g)).toEqual([1364, 763, 1440, 1346])
    // No own properties on the window: the engine's own accessors stay in charge.
    expect(vm.runInContext('Object.getOwnPropertyDescriptor(window, "outerWidth").get.name', g)).not.toBe('get outerWidth')
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
