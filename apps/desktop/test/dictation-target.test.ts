import { describe, expect, it } from 'vitest'

import { dictationTarget } from '../src/main/dictation/target'

interface FakeWindow {
  name: string
  destroyed?: boolean
  pill?: boolean
}

const looks = {
  isDestroyed: (window: FakeWindow) => window.destroyed === true,
  isPill: (window: FakeWindow) => window.pill === true,
}

describe('dictationTarget: which window a dictation goes to, and whether the pill shows', () => {
  const main: FakeWindow = { name: 'main' }
  const quick: FakeWindow = { name: 'quick' }
  const pill: FakeWindow = { name: 'pill', pill: true }

  it('the message box microphone: that window, no pill', () => {
    expect(dictationTarget({ requested: main, focused: null, ...looks })).toEqual({ target: main, surface: 'app' })
    expect(dictationTarget({ requested: main, focused: quick, ...looks })).toEqual({ target: main, surface: 'app' })
  })

  it('the shortcut while an app window is in front (main or quick chat): that window, no pill', () => {
    expect(dictationTarget({ requested: null, focused: main, ...looks })).toEqual({ target: main, surface: 'app' })
    expect(dictationTarget({ requested: null, focused: quick, ...looks })).toEqual({ target: quick, surface: 'app' })
  })

  it('the shortcut while another app is in front: no window, the pill', () => {
    expect(dictationTarget({ requested: null, focused: null, ...looks })).toEqual({ target: null, surface: 'pill' })
    expect(dictationTarget({ requested: null, focused: pill, ...looks })).toEqual({ target: null, surface: 'pill' })
    expect(dictationTarget({ requested: { name: 'gone', destroyed: true }, focused: null, ...looks })).toEqual({ target: null, surface: 'pill' })
  })
})
