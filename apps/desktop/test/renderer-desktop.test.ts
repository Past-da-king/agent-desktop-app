import { describe, expect, it } from 'vitest'

import { attachmentsFromMeta, folderName, isImageFile } from '../src/renderer/lib/files'
import { acceleratorFromEvent, formatAccelerator } from '../src/renderer/lib/hotkey'
import { machineSummary, platformLabel } from '../src/renderer/lib/system'
import { hashFor, parseHash } from '../src/renderer/state/route'

describe('quick window route', () => {
  it('parses and writes the frameless window hash', () => {
    expect(parseHash('#/quick-window')).toEqual({ page: 'quick-window' })
    expect(hashFor({ page: 'quick-window' })).toBe('#/quick-window')
  })
})

describe('hotkey recorder', () => {
  it('builds the default accelerator from a key press', () => {
    const press = { key: ' ', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }
    expect(acceleratorFromEvent(press, 'win32')).toBe('CommandOrControl+Shift+Space')
  })

  it('uses Command on a Mac and Super for the Windows key', () => {
    const cmd = { key: 'k', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }
    expect(acceleratorFromEvent(cmd, 'darwin')).toBe('Command+K')
    expect(acceleratorFromEvent(cmd, 'linux')).toBe('Super+K')
  })

  it('refuses a bare letter or a lone modifier', () => {
    expect(acceleratorFromEvent({ key: 'a', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, 'win32')).toBeNull()
    expect(acceleratorFromEvent({ key: 'Shift', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, 'win32')).toBeNull()
  })

  it('reads an accelerator back for a person', () => {
    expect(formatAccelerator('CommandOrControl+Shift+Space', 'win32')).toEqual(['Ctrl', 'Shift', 'Space'])
    expect(formatAccelerator('CommandOrControl+Alt+K', 'darwin')).toEqual(['Cmd', 'Option', 'K'])
  })
})

describe('attachment helpers', () => {
  it('reads a folder name from either separator', () => {
    expect(folderName('C:\\Users\\You\\Documents\\')).toBe('Documents')
    expect(folderName('/home/you/Pictures')).toBe('Pictures')
    expect(folderName('/')).toBe('/')
  })

  it('knows an image by mime or by name', () => {
    expect(isImageFile({ mime: 'image/png', name: 'x' })).toBe(true)
    expect(isImageFile({ mime: 'application/octet-stream', name: 'scan.JPG' })).toBe(true)
    expect(isImageFile({ mime: 'application/pdf', name: 'brief.pdf' })).toBe(false)
  })

  it('reads attachments from chat meta and ignores the old count', () => {
    expect(attachmentsFromMeta(2)).toEqual([])
    expect(
      attachmentsFromMeta([
        { path: '/tmp/a.png', name: 'a.png', mime: 'image/png', size: 12 },
        { path: '' },
        'nope',
      ]),
    ).toEqual([{ path: '/tmp/a.png', name: 'a.png', mime: 'image/png', size: 12 }])
  })
})

describe('machine line', () => {
  it('names the platform and joins the host', () => {
    expect(platformLabel('win32')).toBe('Windows')
    expect(platformLabel('darwin')).toBe('macOS')
    expect(platformLabel('web')).toBe('Browser preview')
    expect(
      machineSummary({ platform: 'linux', arch: 'arm64', hostname: 'studio', appVersion: '1.0.0' }),
    ).toBe('Linux arm64, studio')
  })
})
