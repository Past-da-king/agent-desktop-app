import { describe, expect, it } from 'vitest'

import {
  APP_NAME,
  LICENCES_URL,
  makeAppInfo,
  notificationTitle,
  trayTooltip,
  windowTitle,
} from '../src/main/app-info'

describe('app identity', () => {
  it('uses one product name everywhere', () => {
    expect(APP_NAME).toBe('Agent')
    expect(windowTitle()).toBe(APP_NAME)
    expect(trayTooltip()).toBe(APP_NAME)
    expect(notificationTitle()).toBe(APP_NAME)
  })

  it('builds the About details from the running process', () => {
    const info = makeAppInfo({
      version: '1.2.3',
      platform: 'win32',
      electron: '44.9.1',
      logsPath: 'C:\\Users\\person\\AppData\\Roaming\\Agent\\logs',
    })
    expect(info).toEqual({
      name: 'Agent',
      version: '1.2.3',
      platform: 'win32',
      electron: '44.9.1',
      logsPath: 'C:\\Users\\person\\AppData\\Roaming\\Agent\\logs',
      licencesUrl: LICENCES_URL,
    })
  })

  it('falls back to a version rather than showing an empty string', () => {
    const info = makeAppInfo({ version: '', platform: 'linux', electron: '', logsPath: '' })
    expect(info.version).toBe('0.0.0')
    expect(info.electron).toBe('0.0.0')
  })

  it('links to a real licence page, not a project site', () => {
    expect(LICENCES_URL).toMatch(/^https:\/\//)
    expect(LICENCES_URL).toContain('LICENSE')
  })
})
