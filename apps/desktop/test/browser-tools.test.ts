import { describe, expect, it } from 'vitest'

import type { Tool } from '@agent/core'

import type { BrowserDriver } from '../src/main/browser/types'
import { browserTools } from '../src/main/tools/browser'
import { testContext, toolNamed } from './support'

class FakeBrowser implements BrowserDriver {
  readonly calls: string[] = []
  readonly driving: Array<{ on: boolean; reason: string }> = []
  lastIndex = -1
  lastText = ''
  lastSubmit = false
  lastKey = ''
  lastDy = 0
  lastQuery = { text: '', selector: '' }
  lastSeconds = 0
  lastUpload = { index: -1, path: '' }

  async open(url: string): Promise<string> {
    this.calls.push(`open:${url}`)
    return `Opened ${url}`
  }

  async snapshot(): Promise<string> {
    this.calls.push('snapshot')
    return 'Snapshot'
  }

  async read(target: { index?: number; selector?: string } = {}): Promise<string> {
    this.calls.push(`read:${target.index ?? ''}:${target.selector ?? ''}`)
    return 'Read text'
  }

  async click(index: number): Promise<string> {
    this.calls.push(`click:${index}`)
    this.lastIndex = index
    return `Clicked ${index}`
  }

  async type(index: number, text: string, submit: boolean): Promise<string> {
    this.calls.push(`type:${index}:${submit}`)
    this.lastIndex = index
    this.lastText = text
    this.lastSubmit = submit
    return `Typed ${text}`
  }

  async press(key: string): Promise<string> {
    this.calls.push(`press:${key}`)
    this.lastKey = key
    return `Pressed ${key}`
  }

  async scroll(dy: number): Promise<string> {
    this.calls.push(`scroll:${dy}`)
    this.lastDy = dy
    return 'Scrolled'
  }

  async waitFor(
    query: { text: string; selector: string },
    seconds: number,
    _signal?: AbortSignal,
  ): Promise<string> {
    this.calls.push('waitFor')
    this.lastQuery = query
    this.lastSeconds = seconds
    return "It's there."
  }

  async back(): Promise<string> {
    this.calls.push('back')
    return 'Back'
  }

  async screenshot(): Promise<string | null> {
    this.calls.push('screenshot')
    return '/tmp/agent-browser/shot.png'
  }

  async upload(index: number, path: string): Promise<string> {
    this.calls.push(`upload:${index}:${path}`)
    this.lastUpload = { index, path }
    return 'Uploaded'
  }

  setAgentDriving(on: boolean, reason = ''): void {
    this.driving.push({ on, reason })
  }

  hasPage(): boolean {
    return true
  }
}

function tools(browser: BrowserDriver = new FakeBrowser(), name = 'Nova'): Tool[] {
  return browserTools({ browser, agentName: () => name })
}

describe('browser tools', () => {
  it('registers every browser tool', () => {
    const names = tools().map((tool) => tool.spec.name)
    expect(names).toEqual([
      'browser_open',
      'browser_look',
      'browser_read',
      'browser_click',
      'browser_type',
      'browser_press_key',
      'browser_scroll',
      'browser_wait_for',
      'browser_back',
      'browser_upload',
      'browser_handoff',
      'browser_show_user',
    ])
  })

  it('opens a normal address and refuses local or script addresses', async () => {
    const browser = new FakeBrowser()
    const open = toolNamed(tools(browser), 'browser_open')

    expect(await open.run({ url: 'file:///etc/passwd' }, testContext())).toContain('Only web addresses')
    expect(await open.run({ url: 'javascript:alert(1)' }, testContext())).toContain('Only web addresses')
    expect(await open.run({ url: '127.0.0.1' }, testContext())).toContain('Only you can open')
    expect(await open.run({ url: '' }, testContext())).toBe('Pass the web address to open.')
    expect(browser.calls).toEqual([])

    expect(await open.run({ url: 'example.com' }, testContext())).toBe('Opened https://example.com/')
    expect(browser.calls).toEqual(['open:https://example.com/'])
  })

  it('reads by index, selector or the whole page', async () => {
    const browser = new FakeBrowser()
    const read = toolNamed(tools(browser), 'browser_read')

    await read.run({}, testContext())
    await read.run({ index: 3 }, testContext())
    await read.run({ selector: '#where' }, testContext())
    expect(browser.calls).toEqual(['read::', 'read:3:', 'read::#where'])
  })

  it('validates the element number before clicking or typing', async () => {
    const browser = new FakeBrowser()
    const click = toolNamed(tools(browser), 'browser_click')
    const type = toolNamed(tools(browser), 'browser_type')

    for (const bad of [-1, 1.5, 'abc', undefined]) {
      expect(await click.run({ index: bad }, testContext())).toBe(
        'Pass the number of the element from the outline.',
      )
      expect(await type.run({ index: bad, text: 'hi' }, testContext())).toBe(
        'Pass the number of the field from the outline.',
      )
    }
    expect(browser.calls).toEqual([])

    expect(await click.run({ index: '2' }, testContext())).toBe('Clicked 2')
    expect(await type.run({ index: 4, text: 'Durban', submit: true }, testContext())).toBe('Typed Durban')
    expect(browser.calls).toEqual(['click:2', 'type:4:true'])
    expect(browser.lastText).toBe('Durban')
    expect(browser.lastSubmit).toBe(true)
  })

  it('rejects an unknown key and scrolls in the asked direction', async () => {
    const browser = new FakeBrowser()
    const key = toolNamed(tools(browser), 'browser_press_key')
    const scroll = toolNamed(tools(browser), 'browser_scroll')

    expect(await key.run({ key: 'F13' }, testContext())).toBe('Use Enter, Tab or Escape.')
    expect(await key.run({ key: 'Tab' }, testContext())).toBe('Pressed Tab')
    expect(browser.lastKey).toBe('Tab')

    await scroll.run({}, testContext())
    await scroll.run({ up: true }, testContext())
    expect(browser.lastDy).toBe(-600)
    expect(browser.calls).toContain('scroll:600')
  })

  it('waits for text or a selector and clamps the timeout', async () => {
    const browser = new FakeBrowser()
    const wait = toolNamed(tools(browser), 'browser_wait_for')

    expect(await wait.run({}, testContext())).toBe('Pass the text or selector to wait for.')
    expect(await wait.run({ text: 'Done', seconds: 900 }, testContext())).toBe("It's there.")
    expect(browser.lastQuery.text).toBe('Done')
    expect(browser.lastSeconds).toBe(30)
    expect(await wait.run({ selector: '#done', seconds: 0 }, testContext())).toBe("It's there.")
    expect(browser.lastSeconds).toBe(1)
  })

  it('hands the browser to the person and takes it back afterwards', async () => {
    const browser = new FakeBrowser()
    const handoff = toolNamed(tools(browser), 'browser_handoff')
    let asked = ''
    let offered: string[] = []
    const notifications: string[] = []

    const result = await handoff.run(
      { reason: 'Sign in to the bank' },
      testContext({
        ask: async (question, options) => {
          asked = question
          offered = options
          return 'Done, carry on'
        },
        notify: async (title) => {
          notifications.push(title)
        },
      }),
    )

    expect(asked).toBe('Nova needs you in the browser: Sign in to the bank')
    expect(offered).toEqual(['Done, carry on', 'Skip'])
    expect(notifications).toEqual(['Your agent needs a hand'])
    expect(result).toBe('The user says they are done. Read the page to check.')
    expect(browser.driving).toEqual([
      { on: false, reason: 'Sign in to the bank' },
      { on: true, reason: '' },
    ])
  })

  it('handles a skip and nobody being there, and always gives control back', async () => {
    const browser = new FakeBrowser()
    const handoff = toolNamed(tools(browser), 'browser_handoff')

    const skipped = await handoff.run(
      { reason: 'Captcha' },
      testContext({ ask: async () => 'Skip' }),
    )
    expect(skipped).toBe('The user skipped it.')

    const absent = await handoff.run(
      { reason: 'Captcha' },
      testContext({ ask: async () => null }),
    )
    expect(absent).toBe('No one is around to help right now.')

    expect(browser.driving.filter((entry) => entry.on === true)).toHaveLength(2)
    expect(await handoff.run({ reason: ' ' }, testContext())).toBe(
      'Say what the person needs to do in reason.',
    )
  })

  it('shows screenshots to the person and to the model', async () => {
    const browser = new FakeBrowser()
    const look = toolNamed(tools(browser), 'browser_look')
    const show = toolNamed(tools(browser), 'browser_show_user')

    expect(await look.run({}, testContext())).toBe('Here is the page:\n[[image:/tmp/agent-browser/shot.png]]')
    expect(await show.run({ caption: 'The receipt' }, testContext())).toContain(
      '[[image:/tmp/agent-browser/shot.png]]',
    )
    expect(await show.run({ caption: 'The receipt' }, testContext())).toContain('The receipt')
  })

  it('asks before uploading a file and reports a declined upload', async () => {
    const browser = new FakeBrowser()
    const upload = toolNamed(tools(browser), 'browser_upload')

    expect(await upload.run({ index: 1, path: '' }, testContext())).toBe(
      'Pass the full path of the file to upload.',
    )
    expect(await upload.run({ index: 1, path: '/tmp/report.pdf' }, testContext())).toBe(
      'The user declined the upload.',
    )
    expect(browser.calls).toEqual([])

    let summary = ''
    const result = await upload.run(
      { index: 2, path: '/tmp/report.pdf' },
      testContext({
        approve: async (line) => {
          summary = line
          return true
        },
      }),
    )
    expect(summary).toBe('Upload report.pdf to the page?')
    expect(result).toBe('Uploaded')
    expect(browser.lastUpload).toEqual({ index: 2, path: '/tmp/report.pdf' })
  })

  it('goes back and reads the current page', async () => {
    const browser = new FakeBrowser()
    const back = toolNamed(tools(browser), 'browser_back')
    const read = toolNamed(tools(browser), 'browser_read')
    expect(await back.run({}, testContext())).toBe('Back')
    expect(await read.run({}, testContext())).toBe('Read text')
  })
})
