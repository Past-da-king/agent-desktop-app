/**
 * Google's "Continue with Google", and Facebook's and Apple's buttons, finish by opening a window from the click
 * itself and then posting the result back to the opener. These hold the rule that decides what each window.open
 * becomes, so a sign-in gets a real window while a script with no click behind it still gets nothing.
 */
import { describe, expect, it } from 'vitest'

import { GESTURE_MS, isPopupWindow, planWindowOpen, popupSize, type WindowOpenRequest } from '../src/main/browser/popup'

/** What Google's Identity Services asks for when the person clicks its button. */
const GIS_FEATURES = 'width=500,height=600,left=1,top=1'
const GIS_URL =
  'https://accounts.google.com/o/oauth2/v2/auth?client_id=1&redirect_uri=gis_transform&response_mode=form_post'

function ask(over: Partial<WindowOpenRequest> = {}): WindowOpenRequest {
  return {
    url: GIS_URL,
    disposition: 'new-window',
    features: GIS_FEATURES,
    gestureAgeMs: 120,
    tabsOpen: 1,
    maxTabs: 5,
    persons: true,
    ...over,
  }
}

describe('a page asking for a window', () => {
  it('gets a real window when a click opened it, so the sign-in flow can post back to the opener', () => {
    expect(planWindowOpen(ask())).toEqual({ action: 'popup' })
  })

  it('gets one even when the tabs are full, because a popup is a window and not a tab', () => {
    expect(planWindowOpen(ask({ tabsOpen: 5 }))).toEqual({ action: 'popup' })
  })

  it('gets a tab in the app for a link that asked for a new tab', () => {
    expect(planWindowOpen(ask({ disposition: 'foreground-tab', features: '' }))).toEqual({ action: 'tab', url: GIS_URL })
    expect(planWindowOpen(ask({ disposition: 'background-tab', features: '' }))).toEqual({ action: 'tab', url: GIS_URL })
  })

  it('gets nothing when no click is behind it', () => {
    expect(planWindowOpen(ask({ gestureAgeMs: Number.POSITIVE_INFINITY }))).toEqual({
      action: 'deny',
      reason: 'A page tried to open a window without a click.',
    })
    expect(planWindowOpen(ask({ gestureAgeMs: GESTURE_MS + 1 })).action).toBe('deny')
    // A click still counts right up to the limit Chromium gives it.
    expect(planWindowOpen(ask({ gestureAgeMs: GESTURE_MS, disposition: 'foreground-tab', features: '' })).action).toBe('tab')
  })

  it('opens the person’s own click in front of them when the tabs are full, and tells an agent why not', () => {
    const link = { disposition: 'foreground-tab', features: '', tabsOpen: 5 }
    expect(planWindowOpen(ask({ ...link, persons: true }))).toEqual({ action: 'same-tab', url: GIS_URL })
    expect(planWindowOpen(ask({ ...link, persons: false }))).toEqual({
      action: 'deny',
      reason: 'There are already 5 browser tabs open.',
    })
  })
})

describe('what counts as a popup', () => {
  it('is a window Chromium marks as one, or one that asked for its own size', () => {
    expect(isPopupWindow('new-window', '')).toBe(true)
    expect(isPopupWindow('default', 'popup,width=480,height=640')).toBe(true)
    expect(isPopupWindow('default', 'height=640')).toBe(true)
  })

  it('is not a link that asked for a tab', () => {
    expect(isPopupWindow('foreground-tab', '')).toBe(false)
    expect(isPopupWindow('background-tab', 'noopener,noreferrer')).toBe(false)
    expect(isPopupWindow('default', '')).toBe(false)
  })
})

describe('the size a sign-in window opens at', () => {
  it('is the size the page asked for', () => {
    expect(popupSize(GIS_FEATURES)).toEqual({ width: 500, height: 600 })
  })

  it('is usable when the page asked for nothing, or for something too small or too big', () => {
    expect(popupSize('')).toEqual({ width: 500, height: 700 })
    expect(popupSize('width=1,height=1')).toEqual({ width: 360, height: 420 })
    expect(popupSize('width=4000,height=4000')).toEqual({ width: 1200, height: 1000 })
  })
})
