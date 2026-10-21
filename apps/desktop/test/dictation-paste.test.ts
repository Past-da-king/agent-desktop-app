import { existsSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  HELPER_SCRIPT,
  WindowsKeys,
  encodeCommand,
  helperCommand,
  helperLine,
  keySenderFor,
  typeText,
  electronClipboard,
  type ClipboardLike,
  type KeySender,
} from '../src/main/dictation/paste'

/** A clipboard like Electron 44's (async, item based) behind the adapter, so the adapter is tested too. */
function clipboard(initial: Record<string, string> = {}): ClipboardLike & { log: string[]; items: () => Array<Record<string, unknown>> } {
  let items: Array<Record<string, unknown>> = Object.keys(initial).length === 0 ? [] : [{ ...initial }]
  const log: string[] = []
  const fake = {
    read: async () => items.map((entries) => ({ types: Object.keys(entries), getType: async (type: string) => entries[type] })),
    readText: async () => String(items[0]?.['text/plain'] ?? ''),
    write: async (next: never[]) => {
      const written = next as unknown as Array<{ entries: Record<string, unknown> }>
      log.push(`write:${written.map((item) => Object.keys(item.entries).sort().join(',')).join('|')}`)
      items = written.map((item) => ({ ...item.entries }))
    },
    writeText: async (text: string) => {
      log.push(`writeText:${text}`)
      items = [{ 'text/plain': text }]
    },
    clear: () => {
      log.push('clear')
      items = []
    },
  }
  const adapter = electronClipboard(fake, (entries) => ({ entries }))
  return { ...adapter, log, items: () => items }
}

function keys(ok: boolean, during?: () => void): KeySender & { pastes: number } {
  const sender = {
    pastes: 0,
    paste: async () => {
      sender.pastes += 1
      during?.()
      return ok
    },
    mask: () => undefined,
    warm: () => undefined,
    dispose: () => undefined,
  }
  return sender
}

const noWait = async (): Promise<void> => undefined

describe('typeText', () => {
  it('puts the words on the clipboard, pastes, then brings the old clipboard back', async () => {
    const board = clipboard({ 'text/plain': 'what I copied before', 'text/html': '<b>before</b>' })
    let seen = ''
    const sender = keys(true, () => {
      void board.readText().then((text) => {
        seen = text
      })
    })
    expect(await typeText('Hello from dictation', { clipboard: board, keys: sender, wait: noWait })).toBe('pasted')
    expect(seen).toBe('Hello from dictation')
    expect(sender.pastes).toBe(1)
    expect(board.items()).toEqual([{ 'text/plain': 'what I copied before', 'text/html': '<b>before</b>' }])
    expect(board.log).toEqual(['writeText:Hello from dictation', 'write:text/html,text/plain'])
  })

  it('restores an image and clears a clipboard that was empty', async () => {
    const withImage = clipboard({ 'image/png': 'PNGDATA' })
    await typeText('words', { clipboard: withImage, keys: keys(true), wait: noWait })
    expect(withImage.items()).toEqual([{ 'image/png': 'PNGDATA' }])

    const empty = clipboard()
    await typeText('words', { clipboard: empty, keys: keys(true), wait: noWait })
    expect(empty.log.at(-1)).toBe('clear')
    expect(await empty.readText()).toBe('')
  })

  it('leaves the words copied when the keys cannot be sent', async () => {
    const board = clipboard({ 'text/plain': 'before' })
    expect(await typeText('the words', { clipboard: board, keys: keys(false), wait: noWait })).toBe('copied')
    expect(await board.readText()).toBe('the words')
    expect(await typeText('again', { clipboard: board, keys: null, wait: noWait })).toBe('copied')
    expect(await board.readText()).toBe('again')
  })

  it('does not overwrite something the person copied while the paste ran', async () => {
    const board = clipboard({ 'text/plain': 'before' })
    const wait = async (): Promise<void> => {
      await board.writeText('copied meanwhile')
    }
    await typeText('dictated', { clipboard: board, keys: keys(true), wait })
    expect(await board.readText()).toBe('copied meanwhile')
  })
})

describe('the Windows helper command', () => {
  it('starts Windows PowerShell hidden, without a profile, with the script encoded', () => {
    const { file, args } = helperCommand({ SystemRoot: 'C:\\Windows' })
    expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(args.slice(0, -1)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand'])
    const decoded = Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le')
    expect(decoded).toBe(HELPER_SCRIPT)
    expect(encodeCommand('A')).toBe(Buffer.from([0x41, 0x00]).toString('base64'))
  })

  it('sends Ctrl+V with keybd_event after the modifiers are let go, and masks a lone Alt with VK 0xE8', () => {
    expect(HELPER_SCRIPT).toContain('keybd_event(0x11, 0, 0, UIntPtr.Zero)')
    expect(HELPER_SCRIPT).toContain('keybd_event(0x56, 0, 0, UIntPtr.Zero)')
    expect(HELPER_SCRIPT).toContain('keybd_event(0xE8, 0, 0, UIntPtr.Zero)')
    expect(HELPER_SCRIPT).toContain('WaitForRelease(1500)')
    expect(HELPER_SCRIPT.indexOf('WaitForRelease(1500)')).toBeLessThan(HELPER_SCRIPT.indexOf('[AgentKeys]::Paste()'))
    expect(helperLine('paste', 7)).toBe('paste 7\n')
  })

  it('picks a sender per platform', () => {
    expect(keySenderFor('win32', { SystemRoot: 'C:\\Windows' })).toBeInstanceOf(WindowsKeys)
    expect(keySenderFor('darwin')).not.toBeNull()
    expect(keySenderFor('linux', { PATH: '/nowhere' })).toBeNull()
  })
})

// The real helper, when this machine can start Windows PowerShell (WSL on Windows can). Only `ping` and `mask` run:
// mask taps an unassigned key, so nothing is typed into whatever window is in front.
const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
describe.runIf(existsSync(powershell))('the real Windows helper', () => {
  it('starts once and answers each command in a few milliseconds', async () => {
    const { args } = helperCommand({ SystemRoot: 'C:\\Windows' })
    const helper = new WindowsKeys({ file: powershell, args })
    const started = performance.now()
    expect(await helper.whenReady(20_000)).toBe(true)
    const startup = performance.now() - started
    const times: number[] = []
    for (let index = 0; index < 20; index += 1) {
      const at = performance.now()
      const answer = await helper.send(index % 2 === 0 ? 'ping' : 'mask')
      times.push(performance.now() - at)
      expect(answer).toMatch(/^ok \d+ (pong|masked)$/)
    }
    helper.dispose()
    times.sort((a, b) => a - b)
    const median = times[Math.floor(times.length / 2)] ?? 0
    console.log(`helper startup ${Math.round(startup)} ms, round trip median ${median.toFixed(1)} ms, max ${(times.at(-1) ?? 0).toFixed(1)} ms`)
    expect(median).toBeLessThan(100)
  }, 40_000)
})
