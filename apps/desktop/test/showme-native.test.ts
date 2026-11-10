/**
 * The native side of "show me how" (main/showme/native): the reader that talks to the agent-screen helper.
 * A stand-in helper (fixtures/fake-agent-screen.mjs) speaks the same lines, so this runs on any computer.
 * The real helper is proved on Windows by tools/agent-screen/proof/proof.mjs.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createScreenReader, findScreenSidecar, ScreenReadError } from '../src/main/showme/native'
import type { NativeScreenReader, SpawnLike } from '../src/main/showme/native'
import { parseSidecarLine } from '../src/main/showme/native/sidecar'
import { displayAt, parseInput, parseNode, parseWindow } from '../src/main/showme/native/windows'
import type { InputEvent, Rect, ScreenReader } from '../src/main/showme/screen'

const FAKE = join(__dirname, 'fixtures', 'fake-agent-screen.mjs')
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async (fn: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('waited too long')
    await wait(10)
  }
}
const have = (paths: string[]) => (path: string): boolean => paths.includes(path)

describe('finding the helper', () => {
  it('looks in the env, the packed resources, then the repo', () => {
    expect(findScreenSidecar({ platform: 'win32', env: { AGENT_SCREEN_PATH: 'X:/a.exe' }, exists: have(['X:/a.exe']) })).toBe('X:/a.exe')
    const packed = join('C:/r', 'agent-screen', 'agent-screen.exe')
    expect(findScreenSidecar({ platform: 'win32', env: {}, resourcesPath: 'C:/r', exists: have([packed]) })).toBe(packed)
    const repo = join('/repo', 'tools', 'agent-screen', 'bin', 'win-x64', 'agent-screen.exe')
    expect(findScreenSidecar({ platform: 'win32', arch: 'x64', env: {}, dirs: ['/repo'], exists: have([repo]) })).toBe(repo)
    expect(findScreenSidecar({ platform: 'win32', arch: 'arm64', env: {}, dirs: ['/repo'], exists: have([repo]) })).toBe(repo)
    expect(findScreenSidecar({ platform: 'win32', env: {}, dirs: ['/repo'], exists: () => false })).toBeNull()
  })

  it('has none outside Windows', () => {
    expect(findScreenSidecar({ platform: 'linux', env: { AGENT_SCREEN_PATH: '/x' }, exists: () => true })).toBeNull()
    expect(findScreenSidecar({ platform: 'darwin', resourcesPath: '/r', exists: () => true })).toBeNull()
  })
})

describe('where it cannot work', () => {
  it('says so and never throws from available()', async () => {
    const reader = createScreenReader({ platform: 'linux' })
    expect(await reader.available()).toBe(false)
    expect(reader.unavailableReason()).toMatch(/Windows only/)
    expect(await reader.activeWindow()).toBeNull()
    await expect(reader.tree('0x1')).rejects.toBeInstanceOf(ScreenReadError)
    await expect(reader.capture({ displayId: 1 })).rejects.toMatchObject({ code: 'unavailable' })
    const moves: Array<Rect | null> = []
    reader.watch('0x1', { id: 'n1', role: 'button', name: 'x', bounds: { x: 0, y: 0, width: 1, height: 1 }, enabled: true, offscreen: false, path: '' }, (r) => moves.push(r))()
    expect(moves).toEqual([null])
    reader.onInput(() => undefined)()
    reader.dispose()
  })

  it('says the helper is missing on Windows without one', async () => {
    const reader = createScreenReader({ platform: 'win32', binary: () => null, spawn: (() => { throw new Error('not reached') }) as SpawnLike })
    expect(await reader.available()).toBe(false)
    expect(reader.unavailableReason()).toMatch(/missing/)
    await expect(reader.find('0x1', { name: 'x' })).rejects.toMatchObject({ code: 'unavailable' })
    reader.dispose()
  })
})

describe('reading the lines', () => {
  it('drops what is not an object line', () => {
    expect(parseSidecarLine('')).toBeNull()
    expect(parseSidecarLine('hello')).toBeNull()
    expect(parseSidecarLine('[1]')).toBeNull()
    expect(parseSidecarLine('{"id":1')).toBeNull()
    expect(parseSidecarLine('{"id":1,"ok":true}')).toEqual({ id: 1, ok: true })
  })

  it('checks windows, nodes and events', () => {
    expect(parseWindow({ hwnd: '0x1', bounds: { x: 0, y: 0, width: 0, height: 5 } }, [])).toBeNull()
    expect(parseWindow({ hwnd: '0x1', pid: 4, process: 'p', title: 't', bounds: { x: 10.4, y: 0, width: 5, height: 5 }, url: '' }, [])).toEqual({ hwnd: '0x1', pid: 4, process: 'p', title: 't', bounds: { x: 10, y: 0, width: 5, height: 5 }, className: '', elevated: false })
    expect(parseNode({ id: 'n1', role: 'button', name: 'A', bounds: { x: 1, y: 2, width: 3, height: 4 }, enabled: false, offscreen: true, path: 'P' })).toEqual({ id: 'n1', role: 'button', name: 'A', bounds: { x: 1, y: 2, width: 3, height: 4 }, enabled: false, offscreen: true, path: 'P' })
    expect(parseNode({ id: '', bounds: {} })).toBeNull()
    expect(parseInput({ event: 'input', kind: 'click', x: 1, y: 2, button: 'left', time: 5 }, [])).toEqual({ kind: 'click', x: 1, y: 2, button: 'left', time: 5 })
    expect(parseInput({ event: 'input', kind: 'click', x: 1, y: 2, button: 'thumb', time: 5 }, [])).toBeNull()
    expect(parseInput({ event: 'input', kind: 'typed', text: 'secret' }, [])).toBeNull()
    expect(parseInput({ event: 'input', kind: 'key', key: '', time: 5 }, [])).toBeNull()
  })

  it('puts a window on the display that holds its middle, also left of the main screen', () => {
    const displays = [{ id: 7, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }, { id: 9, bounds: { x: -1280, y: 0, width: 1280, height: 1024 } }]
    expect(displayAt(displays, { x: 100, y: 50, width: 1000, height: 800 })?.id).toBe(7)
    expect(displayAt(displays, { x: -1200, y: 40, width: 600, height: 400 })?.id).toBe(9)
    expect(displayAt(displays, { x: -100, y: 40, width: 150, height: 400 })?.id).toBe(9)
    expect(displayAt(displays, { x: 5000, y: 5000, width: 10, height: 10 })).toBeNull()
    expect(displayAt([], { x: 0, y: 0, width: 10, height: 10 })).toBeNull()
  })
})

describe('the reader, against a stand-in helper', () => {
  let dir = ''
  let logFile = ''
  let reader: NativeScreenReader
  const spawned: number[] = []
  const fakeSpawn: SpawnLike = (_command, args, options) => {
    const child = spawn(process.execPath, [FAKE, ...args], { ...options, env: { ...process.env, FAKE_SCREEN_LOG: logFile } })
    if (child.pid !== undefined) spawned.push(child.pid)
    return child
  }
  const logged = (): Array<Record<string, unknown>> =>
    existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>) : []
  const requests = (op: string): Array<Record<string, unknown>> => logged().filter((l) => l['type'] === 'request' && l['op'] === op)
  const make = (extra: Parameters<typeof createScreenReader>[0] = {}): NativeScreenReader =>
    createScreenReader({
      platform: 'win32',
      binary: () => 'agent-screen.exe',
      spawn: fakeSpawn,
      excludePids: () => [111, 222],
      displays: () => [{ id: 7, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }, { id: 9, bounds: { x: -1280, y: 0, width: 1280, height: 1024 } }],
      ...extra,
    })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'showme-native-'))
    logFile = join(dir, 'log.jsonl')
    spawned.length = 0
    reader = make()
  })
  afterEach(async () => {
    reader.dispose()
    await wait(150)
    rmSync(dir, { recursive: true, force: true })
  })

  it('satisfies the engine interface', () => {
    const plain: ScreenReader = reader
    expect(typeof plain.find).toBe('function')
  })

  it('gives the keyboard back to a window, and says when it could not', async () => {
    expect(await reader.focus('0x10')).toBe(true)
    expect(await reader.focus('0x77')).toBe(false)
    expect(requests('focus').map((r) => r['hwnd'])).toEqual(['0x10', '0x77'])
  })

  it('starts the helper only when first asked, with this process as its parent', async () => {
    expect(spawned).toHaveLength(0)
    expect(await reader.available()).toBe(true)
    expect(spawned).toHaveLength(1)
    expect(logged()[0]).toMatchObject({ type: 'start', args: ['--parent', String(process.pid)] })
  })

  it("tells the helper whose windows to leave out before anything else", async () => {
    await reader.activeWindow()
    const order = logged().filter((l) => l['type'] === 'request').map((l) => l['op'])
    expect(order).toEqual(['exclude', 'activeWindow'])
    expect(requests('exclude')[0]?.['pids']).toEqual([111, 222])
    await reader.activeWindow()
    expect(requests('exclude')).toHaveLength(1)
  })

  it('gives the active window with its address and display', async () => {
    const window = await reader.activeWindow()
    expect(window).toMatchObject({ hwnd: '0x10', pid: 400, process: 'chrome', title: 'Pixels - Google Chrome', url: 'https://example.com/pixels', bounds: { x: 100, y: 50, width: 1000, height: 800 }, displayId: 7, elevated: false })
    expect((await reader.window('0x20'))?.displayId).toBe(9)
    expect((await reader.window('0x20'))?.url).toBeUndefined()
    expect(await reader.window('0x77')).toBeNull()
    expect((await reader.windows()).map((w) => w.hwnd)).toEqual(['0x10', '0x20'])
    expect((await reader.monitors()).map((m) => m.scale)).toEqual([1.25, 1])
  })

  it('reads the tree, drops broken nodes, and never invents a value', async () => {
    const tree = await reader.tree('0x10')
    expect(tree.map((n) => n.name)).toEqual(['Create pixel', 'Pixel name', 'Secret key'])
    expect(tree[1]?.value).toBe('Winter')
    expect(tree[2]?.value).toBeUndefined()
    expect(requests('tree')[0]).toMatchObject({ hwnd: '0x10', max: 400, interactiveOnly: true })
    await reader.tree('0x10', { max: 2, interactiveOnly: false })
    expect(requests('tree')[1]).toMatchObject({ max: 2, interactiveOnly: false })
  })

  it('says when a window cannot be read', async () => {
    await expect(reader.tree('0x99')).rejects.toMatchObject({ name: 'ScreenReadError', code: 'elevated' })
  })

  it('finds by name and role, and gives null for what is not there', async () => {
    expect(await reader.find('0x10', { name: 'create pixel', role: 'button' })).toMatchObject({ id: 'n1', bounds: { x: 200, y: 300, width: 120, height: 40 } })
    expect(requests('find')[0]).toMatchObject({ name: 'create pixel', role: 'button', nth: 1 })
    expect(await reader.find('0x10', { name: 'Nope' })).toBeNull()
    expect(requests('find')[1]?.['role']).toBeUndefined()
    await reader.find('0x10', { name: 'Create pixel', nth: 2 })
    expect(requests('find')[2]?.['nth']).toBe(2)
  })

  it('survives a line that is not JSON', async () => {
    expect(await reader.find('0x10', { name: 'GARBAGE' })).toBeNull()
    expect(await reader.available()).toBe(true)
  })

  it('follows an element until stopped', async () => {
    const node = (await reader.find('0x10', { name: 'Create pixel' }))!
    const moves: Array<Rect | null> = []
    const stop = reader.watch('0x10', node, (r) => moves.push(r))
    await until(() => moves.length === 3)
    expect(moves).toEqual([{ x: 200, y: 300, width: 120, height: 40 }, { x: 200, y: 250, width: 120, height: 40 }, null])
    expect(requests('watch')[0]).toMatchObject({ hwnd: '0x10', node: 'n1', name: 'Create pixel', role: 'button' })
    stop()
    stop()
    await until(() => requests('unwatch').length === 1)
    expect(requests('unwatch')[0]?.['watch']).toBe(1)
  })

  it('stops a watch that was stopped before the helper answered', async () => {
    const node = (await reader.find('0x10', { name: 'Create pixel' }))!
    const moves: Array<Rect | null> = []
    reader.watch('0x10', node, (r) => moves.push(r))()
    await until(() => requests('unwatch').length === 1)
    await wait(120)
    expect(moves).toEqual([])
  })

  it('has the hooks on only while somebody listens', async () => {
    await reader.available()
    expect((await reader.helperState())?.hooks).toBe(false)
    const events: InputEvent[] = []
    const scrolls: Array<{ x: number; y: number }> = []
    const off = reader.onInput((e) => events.push(e))
    const offScroll = reader.onScroll((e) => scrolls.push(e))
    await until(() => events.length >= 4 && scrolls.length >= 1)
    expect(requests('input')).toHaveLength(1)
    expect(requests('input')[0]).toMatchObject({ on: true, keys: ['Escape', 'Enter', 'Tab'], clickOn: 'up' })
    expect((await reader.helperState())?.hooks).toBe(true)
    off()
    await wait(60)
    expect((await reader.helperState())?.hooks).toBe(true)
    offScroll()
    await until(() => requests('input').length === 2)
    expect(requests('input')[1]).toMatchObject({ on: false })
    expect((await reader.helperState())?.hooks).toBe(false)
    // Only what the interface names got through: no wheel, no unknown button, no made-up kind.
    expect(events.map((e) => e.kind)).toEqual(['click', 'key', 'paste', 'foreground'])
    expect(events[0]).toMatchObject({ kind: 'click', x: 260, y: 320, button: 'left' })
    expect(events[1]).toMatchObject({ kind: 'key', key: 'Escape', ctrl: false, alt: false, shift: true })
    expect(events[3]).toMatchObject({ kind: 'foreground', window: { hwnd: '0x20', displayId: 9 } })
    expect(scrolls).toEqual([{ x: 300, y: 400, time: expect.any(Number) }])
    expect(JSON.stringify(events)).not.toContain('never')
  })

  it('asks for other keys when told to', async () => {
    const off = reader.onInput(() => undefined)
    await until(() => requests('input').length === 1)
    reader.setKeys(['Escape', 'F8'])
    await until(() => requests('input').length === 2)
    expect(requests('input')[1]).toMatchObject({ on: true, keys: ['Escape', 'F8'] })
    off()
    await until(() => requests('input').length === 3)
  })

  it('captures a window, and a display by its own id', async () => {
    const png = await reader.capture({ hwnd: '0x10' })
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
    expect(requests('capture')[0]).toMatchObject({ hwnd: '0x10' })
    await reader.capture({ displayId: 9 })
    expect(requests('capture')[1]).toMatchObject({ x: -1280, y: 0, width: 1280, height: 1024 })
    // An id nobody knows: the main screen, as the helper reports it.
    await reader.capture({ displayId: 12345 })
    expect(requests('capture')[2]).toMatchObject({ x: 0, y: 0, width: 1920, height: 1080 })
    reader.dispose()
    reader = make({ captureMaxWidth: 1280 })
    await reader.capture({ hwnd: '0x10' })
    expect(requests('capture')[3]).toMatchObject({ hwnd: '0x10', maxWidth: 1280 })
  })

  it('does not wait for ever on a window that hangs', async () => {
    reader.dispose()
    reader = make({ callTimeoutMs: 150 })
    await expect(reader.find('0x10', { name: 'HANG' })).rejects.toMatchObject({ code: 'timeout' })
    expect(await reader.find('0x10', { name: 'Create pixel' })).not.toBeNull()
  })

  it('tells watchers when the helper dies, and starts it again', async () => {
    const node = (await reader.find('0x10', { name: 'Create pixel' }))!
    const moves: Array<Rect | null> = []
    const stop = reader.watch('0x10', node, (r) => moves.push(r))
    const events: InputEvent[] = []
    const off = reader.onInput((e) => events.push(e))
    await until(() => moves.length === 3 && events.length >= 4)
    await expect(reader.find('0x10', { name: 'CRASH' })).rejects.toMatchObject({ code: 'unavailable' })
    await until(() => moves.length >= 4)
    expect(moves[3]).toBeNull()
    // It comes back by itself for whoever still listens: the hooks and the watch are asked for again.
    await until(() => spawned.length === 2 && requests('input').length === 2 && requests('watch').length === 2, 4000)
    expect(requests('exclude')).toHaveLength(2)
    expect(await reader.find('0x10', { name: 'Create pixel' })).not.toBeNull()
    stop()
    off()
  })

  it('stops the helper after a quiet spell, not while something is followed', async () => {
    reader.dispose()
    reader = make({ idleMs: 120 })
    const node = (await reader.find('0x10', { name: 'Create pixel' }))!
    const stop = reader.watch('0x10', node, () => undefined)
    await wait(400)
    expect(logged().some((l) => l['type'] === 'stop')).toBe(false)
    stop()
    await until(() => logged().some((l) => l['type'] === 'stop'), 2000)
    expect(await reader.available()).toBe(true)
    expect(spawned).toHaveLength(2)
  })

  it('ends the helper on dispose, and the hooks with it', async () => {
    const off = reader.onInput(() => undefined)
    await until(() => requests('input').length === 1)
    reader.dispose()
    await until(() => logged().some((l) => l['type'] === 'stop'), 2000)
    await expect(reader.find('0x10', { name: 'x' })).rejects.toMatchObject({ code: 'unavailable' })
    expect(await reader.available()).toBe(false)
    off()
  })
})
