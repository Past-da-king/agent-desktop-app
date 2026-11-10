/**
 * Hand a page to the agent (10 Nov 2026), the reverse of browser_handoff: the page in front lands in the message
 * box with its address, title, the selected text, a picture of the visible page and the tab's id. One pure function
 * decides what is handed over (shared/hand-over.ts); the main process writes it as ordinary attachments.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Attachment } from '@agent/core'

vi.mock('../src/renderer/bridge', () => ({ agent: { browser: { onHandOver: () => () => undefined, state: async () => ({}) } }, chat: {} }))

import { makeHandOver, pageMenuItems } from '../src/main/browser/hand-over'
import { browserTools } from '../src/main/tools/browser'
import type { BrowserDriver } from '../src/main/browser/types'
import { addHandedFiles, handOverToast } from '../src/renderer/state/useHandOver'
import { HAND_OVER_SELECTION_MAX, buildHandOver, canHandOver, handOverLabel, handOverName, handedPageTitle, isHandedPage } from '../src/shared/hand-over'
import { testContext, toolNamed } from './support'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const page = { tabId: 'tab-3', url: 'https://shop.example/cart?step=2', title: 'Your cart - Shop' }

const roots: string[] = []
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hand-over-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('what is handed over', () => {
  it('carries the address, the title, the selection, the picture and the tab id', () => {
    const handed = buildHandOver({ ...page, selection: '  2 x Blue mug\r\nTotal 240  ', captured: true })
    expect(handed).not.toBeNull()
    expect(handed).toMatchObject({ tabId: 'tab-3', url: page.url, title: page.title, selection: '2 x Blue mug\nTotal 240', selectionCut: false, hasScreenshot: true, problem: '' })
    const note = handed?.note ?? ''
    expect(note).toContain('- Title: Your cart - Shop')
    expect(note).toContain('- Address: https://shop.example/cart?step=2')
    expect(note).toContain('- Tab: tab-3')
    expect(note).toContain('- Picture: attached')
    expect(note).toContain('## Text they selected\n\n2 x Blue mug\nTotal 240')
    // The agent is told how to carry on in that very tab.
    expect(note).toContain('browser_open with tab "tab-3"')
  })

  it('has no selection section when nothing was selected', () => {
    for (const selection of [undefined, null, '', '   \n ']) {
      const handed = buildHandOver({ ...page, selection, captured: true })
      expect(handed?.selection).toBe('')
      expect(handed?.note).not.toContain('Text they selected')
    }
  })

  it('still hands over a page that could not be pictured, and says why', () => {
    const handed = buildHandOver({ ...page, selection: 'Blue mug', captured: false, captureProblem: 'The page did not answer.' })
    expect(handed).toMatchObject({ hasScreenshot: false, problem: 'The page did not answer.', selection: 'Blue mug' })
    expect(handed?.note).toContain('- Picture: none. The page did not answer.')
    expect(handed?.note).not.toContain('Picture: attached')
    // No reason given still reads as a sentence.
    expect(buildHandOver({ ...page, captured: false })?.problem).toBe('The page could not be pictured.')
  })

  it('cuts a very long selection and says so', () => {
    const handed = buildHandOver({ ...page, selection: 'x'.repeat(HAND_OVER_SELECTION_MAX + 500), captured: true })
    expect(handed?.selection.length).toBe(HAND_OVER_SELECTION_MAX)
    expect(handed?.selectionCut).toBe(true)
    expect(handed?.note).toContain(`(the first ${HAND_OVER_SELECTION_MAX} characters)`)
  })

  it('hands over only a real web page', () => {
    expect(buildHandOver({ tabId: 'tab-1', url: '', title: '', captured: false })).toBeNull()
    expect(buildHandOver({ tabId: 'tab-1', url: 'about:blank', title: '', captured: true })).toBeNull()
    expect(buildHandOver({ tabId: 'tab-1', url: 'file:///C:/secret.txt', title: 'x', captured: true })).toBeNull()
    expect(buildHandOver({ tabId: '', url: page.url, title: 'x', captured: true })).toBeNull()
    expect(canHandOver('https://example.com')).toBe(true)
    expect(canHandOver('chrome://settings')).toBe(false)
  })

  it('names its files from the title, or the site when there is none', () => {
    expect(handOverName('Your cart: 2 items / Shop?', page.url)).toBe('Your cart 2 items Shop')
    expect(handOverName('', 'https://www.shop.example/cart')).toBe('shop.example')
    expect(handOverName('  ', '')).toBe('Page')
    expect(handOverName('a'.repeat(200), page.url).length).toBeLessThanOrEqual(60)
    expect(buildHandOver({ ...page, title: '', captured: true })?.note).toContain('- Title: (no title)')
  })

  it('is named after the agent the person named, never a fixed name', () => {
    expect(handOverLabel('Miro')).toBe('Hand to Miro')
    expect(handOverLabel('  ')).toBe('Hand to your agent')
  })

  it('knows its own note among other attachments', () => {
    expect(isHandedPage('Your cart - Shop.page.md')).toBe(true)
    expect(isHandedPage('notes.md')).toBe(false)
    expect(handedPageTitle('Your cart - Shop.page.md')).toBe('Your cart - Shop')
  })
})

describe('handing a page over (main process)', () => {
  it('writes the note and the picture as attachments', async () => {
    const root = tempRoot()
    const handed = await makeHandOver(root, { ...page, selection: 'Blue mug', capture: async () => PNG })
    expect(handed).toMatchObject({ tabId: 'tab-3', url: page.url, title: page.title, selection: 'Blue mug', problem: '' })
    const [note, picture] = handed?.attachments ?? []
    expect(handed?.attachments).toHaveLength(2)
    expect(note?.name).toBe('Your cart - Shop.page.md')
    expect(note?.mime).toBe('text/markdown')
    expect(picture).toMatchObject({ name: 'Your cart - Shop.png', mime: 'image/png', size: PNG.byteLength })
    expect(note?.path.startsWith(root)).toBe(true)
    const text = readFileSync(note?.path ?? '', 'utf8')
    expect(text).toContain('- Tab: tab-3')
    expect(text).toContain('- Picture: attached')
    expect(text).toContain('Blue mug')
    expect([...readFileSync(picture?.path ?? '')]).toEqual([...PNG])
  })

  it('asks the page for the selection when none was given', async () => {
    const handed = await makeHandOver(tempRoot(), { ...page, selection: async () => 'From the page', capture: async () => PNG })
    expect(handed?.selection).toBe('From the page')
  })

  it('hands over without a selection when the page does not answer', async () => {
    const handed = await makeHandOver(tempRoot(), {
      ...page,
      selection: async () => {
        throw new Error('frozen')
      },
      capture: async () => PNG,
    })
    expect(handed?.selection).toBe('')
    expect(handed?.attachments).toHaveLength(2)
  })

  it('hands over a page that cannot be captured: the note alone, saying there is no picture', async () => {
    for (const capture of [async () => null, async () => new Uint8Array(0), async () => Promise.reject(new Error('gone'))]) {
      const handed = await makeHandOver(tempRoot(), { ...page, selection: null, capture })
      expect(handed?.attachments).toHaveLength(1)
      expect(handed?.problem).not.toBe('')
      const text = readFileSync(handed?.attachments[0]?.path ?? '', 'utf8')
      expect(text).toContain('- Picture: none.')
      expect(text).toContain('- Tab: tab-3')
    }
  })

  it('hands over nothing for an empty tab', async () => {
    let asked = false
    const handed = await makeHandOver(tempRoot(), { tabId: 'tab-1', url: 'about:blank', title: '', selection: null, capture: async () => ((asked = true), PNG) })
    expect(handed).toBeNull()
    expect(asked).toBe(false)
  })

  it('never overwrites an earlier hand-over of the same page', async () => {
    const root = tempRoot()
    const first = await makeHandOver(root, { ...page, selection: 'one', capture: async () => PNG })
    const second = await makeHandOver(root, { ...page, selection: 'two', capture: async () => PNG })
    expect(second?.attachments[0]?.path).not.toBe(first?.attachments[0]?.path)
    expect(readFileSync(first?.attachments[0]?.path ?? '', 'utf8')).toContain('one')
  })
})

describe("the page's right-click menu", () => {
  it('offers the hand-over under the name of the agent, like the toolbar button', () => {
    const items = pageMenuItems({ agentName: 'Miro', url: page.url, canGoBack: true, hasSelection: true, editable: false })
    expect(items.at(-1)).toEqual({ id: 'hand-over', label: 'Hand to Miro', enabled: true })
    expect(items.map((item) => item.id)).toEqual(['back', 'reload', 'separator', 'copy', 'separator', 'hand-over'])
  })

  it('greys the hand-over on a page that cannot be handed over', () => {
    const items = pageMenuItems({ agentName: 'Miro', url: 'about:blank', canGoBack: false, hasSelection: false, editable: true })
    expect(items.find((item) => item.id === 'hand-over')).toMatchObject({ enabled: false })
    expect(items.find((item) => item.id === 'back')).toMatchObject({ enabled: false })
    expect(items.map((item) => item.id)).toContain('paste')
    expect(items.map((item) => item.id)).not.toContain('copy')
  })
})

describe('the message box takes the page', () => {
  const file = (name: string): Attachment => ({ path: `/a/${name}`, name, mime: 'text/plain' })

  it('keeps what was there and never adds the same file twice', () => {
    const have = [file('brief.txt')]
    const next = addHandedFiles(have, [file('Cart.page.md'), file('Cart.png')])
    expect(next.map((each) => each.name)).toEqual(['brief.txt', 'Cart.page.md', 'Cart.png'])
    expect(addHandedFiles(next, [file('Cart.page.md')])).toBe(next)
  })

  it('tells the person in the name of their agent, and says when no picture came', () => {
    expect(handOverToast({ title: 'Your cart', url: page.url, problem: '' }, 'Miro')).toBe('Your cart is in your message. Say what Miro should do with it.')
    expect(handOverToast({ title: '', url: page.url, problem: 'The page did not answer.' }, 'Miro')).toBe('The page is in your message. Say what Miro should do with it. No picture came with it: The page did not answer.')
  })
})

describe('browser_open with a handed tab', () => {
  function driver(over: Partial<BrowserDriver>): BrowserDriver {
    return { open: async (url: string) => `opened ${url}`, hasPage: () => true, ...over } as unknown as BrowserDriver
  }

  it('carries on in the tab the person handed over', async () => {
    const taken: string[] = []
    const tools = browserTools({ browser: driver({ takeHandedTab: async (id) => (taken.push(id), `You are now on ${id}`) }) })
    const result = await toolNamed(tools, 'browser_open').run({ tab: 'tab-3' }, testContext())
    expect(taken).toEqual(['tab-3'])
    expect(String(result)).toContain('You are now on tab-3')
  })

  it('still opens an address as before', async () => {
    const tools = browserTools({ browser: driver({ takeHandedTab: async () => 'no' }) })
    expect(String(await toolNamed(tools, 'browser_open').run({ url: 'https://example.com' }, testContext()))).toContain('opened https://example.com')
    expect(String(await toolNamed(tools, 'browser_open').run({}, testContext()))).toContain('Pass the web address')
  })

  it('says so on a browser with no handed tabs', async () => {
    const tools = browserTools({ browser: driver({}) })
    expect(String(await toolNamed(tools, 'browser_open').run({ tab: 'tab-3' }, testContext()))).toContain('no tabs handed over')
  })
})
