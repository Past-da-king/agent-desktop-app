/**
 * "Show me how" as the app runs it: which model walks the steps (main/showme/guide-model.ts: a setting, or the
 * smallest fast model the person's own account lists, never a hardcoded id), the service that starts a walk from the
 * quick chat bar or for an agent (service.ts), and the screen_guide tool. Every model name here is made up.
 */
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { DEFAULT_SETTINGS, keyNameFor, type AiAccount, type LlmProvider, type Msg, type Settings, type ToolContext } from '@agent/core'
import { describe, expect, it } from 'vitest'

import { formatLog } from '../src/main/browser/guide-log'
import { GuideModels, guideAccount, modelSpeed, smallestModel, type GuideModelDeps } from '../src/main/showme/guide-model'
import { appScreenReader } from '../src/main/showme/reader'
import { noScreenReader } from '../src/main/showme/screen'
import { NO_READER, NO_WINDOW, ShowMeService, endLine, type ShowMeDeps } from '../src/main/showme/service'
import { skillSources } from '../src/main/showme/skills'
import { screenGuideTools } from '../src/main/tools/screen-guide'
import { VAULT_FILL_TOOLS, markVaultSteps } from '../src/main/vault/guard'
import type { ShowMeState } from '../src/shared/showme'
import { FakeClipboard, FakeModel, FakeOverlay, FakeScreen, WINDOW, column, node, pause, until } from './helpers/fake-screen'

const PLAN: AiAccount = { id: 'plan1', label: 'Some plan', kind: 'claude', model: '', hasKey: false }
const KEYED: AiAccount = { id: 'key1', label: 'Fast Cloud', kind: 'api', provider: 'custom', baseUrl: 'https://llm.example.com/v1', model: 'atlas-large-pro', hasKey: true }
const OTHER: AiAccount = { id: 'key2', label: 'Other Cloud', kind: 'api', provider: 'custom', baseUrl: 'https://other.example.com/v1', model: 'borealis-standard', hasKey: true }

function settingsOf(accounts: AiAccount[], main: string, guide: Settings['guideModel'] = { account: '', model: '' }): Settings {
  return { ...DEFAULT_SETTINGS, accounts, ai: { main: { account: main, model: '' }, helpers: { account: '', model: '' } }, guideModel: guide }
}

const secretsFor = (...ids: string[]): { get(name: string): string | null } => ({ get: (name) => (ids.some((id) => keyNameFor(id) === name) ? 'made-up-key' : null) })

describe('which model walks the steps', () => {
  it('reads a model class from its name: small and fast, balanced, or big', () => {
    for (const id of ['atlas-mini', 'vega-flash-2', 'north-haiku-9', 'orion-nano', 'lumen-lite', 'pico-small-v3']) expect(modelSpeed(id), id).toBe(0)
    for (const id of ['atlas-standard', 'vega-sonnet-5', 'orion-4']) expect(modelSpeed(id), id).toBe(1)
    for (const id of ['atlas-large-pro', 'north-opus-9', 'deep-reasoner-max', 'vega-ultra']) expect(modelSpeed(id), id).toBe(2)
  })

  it('takes the smallest fast model of a list, the first the provider gave among equals, and never the big one when there is another', () => {
    expect(smallestModel(['atlas-large-pro', 'atlas-standard', 'atlas-mini', 'atlas-nano'])).toBe('atlas-mini')
    expect(smallestModel(['atlas-large-pro', 'atlas-standard'])).toBe('atlas-standard')
    expect(smallestModel(['atlas-large-pro'])).toBe('atlas-large-pro')
    expect(smallestModel([' ', ''])).toBe('')
  })

  it('uses the account the setting names; left automatic, a key account before a plan', () => {
    const secrets = secretsFor('key1', 'key2')
    // The setting wins.
    expect(guideAccount(settingsOf([PLAN, KEYED, OTHER], 'plan1', { account: 'key2', model: '' }), secrets, true)?.id).toBe('key2')
    // Automatic: the main chat's own account when it is a key account.
    expect(guideAccount(settingsOf([PLAN, KEYED, OTHER], 'key2'), secrets, true)?.id).toBe('key2')
    // The main chat runs on a plan: the first key account answers faster than starting the plan's engine.
    expect(guideAccount(settingsOf([PLAN, KEYED, OTHER], 'plan1'), secrets, true)?.id).toBe('key1')
    // Only a plan: the plan.
    expect(guideAccount(settingsOf([PLAN], 'plan1'), secrets, true)?.id).toBe('plan1')
    // A plan on a build that cannot run one, or a key account with no key: nothing.
    expect(guideAccount(settingsOf([PLAN], 'plan1'), secrets, false)).toBeNull()
    expect(guideAccount(settingsOf([KEYED], 'key1'), secretsFor(), true)).toBeNull()
    expect(guideAccount(settingsOf([], ''), secrets, true)).toBeNull()
    // A setting that names an account that is gone falls back to automatic.
    expect(guideAccount(settingsOf([KEYED], 'key1', { account: 'gone', model: 'x' }), secrets, true)?.id).toBe('key1')
  })

  function models(settings: Settings, extra: Partial<GuideModelDeps> = {}): { guide: GuideModels; asked: Array<{ model: string; messages: Msg[]; system: string }>; listed: string[]; dir: string } {
    const asked: Array<{ model: string; messages: Msg[]; system: string }> = []
    const listed: string[] = []
    const dir = mkdtempSync(join(tmpdir(), 'agent-showme-'))
    const provider: LlmProvider = {
      name: 'fake',
      complete: async (system, messages, _tools, model) => {
        asked.push({ model, messages, system })
        return { message: { role: 'ASSISTANT', blocks: [{ t: 'text', text: `answer from ${model}` }] } as Msg, stopReason: 'end', usage: { input: 0, output: 0 } as never }
      },
    }
    const guide = new GuideModels({
      settings: { get: () => settings },
      secrets: secretsFor('key1', 'key2'),
      providerFactory: () => provider,
      hasCli: true,
      listModels: async (account) => {
        listed.push(account.id)
        return account.id === 'key1' ? ['atlas-large-pro', 'atlas-standard', 'atlas-mini'] : account.id === 'plan1' ? ['big', 'medium', 'tiny'] : []
      },
      tmpDir: dir,
      ...extra,
    })
    return { guide, asked, listed, dir }
  }

  it('automatic: the smallest fast model the account lists today, asked once and kept', async () => {
    const { guide, asked, listed } = models(settingsOf([PLAN, KEYED], 'plan1'))
    const model = await guide.resolve()
    if (!('complete' in model)) throw new Error(model.message)
    expect(model.name).toBe('Fast Cloud · atlas-mini')
    expect(await model.complete('system', 'prompt')).toBe('answer from atlas-mini')
    expect(asked[0]).toMatchObject({ model: 'atlas-mini', system: 'system' })
    // Not the account's own (big) model, and the list is not fetched again for the next walk.
    await guide.resolve()
    expect(listed).toEqual(['key1'])
    expect(await guide.describe()).toEqual({ ok: true, account: 'Fast Cloud', model: 'atlas-mini' })
  })

  it('the setting names the model: that one, with no list asked', async () => {
    const { guide, listed } = models(settingsOf([PLAN, KEYED], 'plan1', { account: 'key1', model: 'atlas-standard' }))
    const model = await guide.resolve()
    expect('complete' in model && model.name).toBe('Fast Cloud · atlas-standard')
    expect(listed).toEqual([])
  })

  it('an account that lists nothing: the smallest of the models Settings already names for it', async () => {
    const settings = { ...settingsOf([OTHER], 'key2'), ai: { main: { account: 'key2', model: '' }, helpers: { account: 'key2', model: 'borealis-flash' } } }
    const { guide } = models(settings)
    const model = await guide.resolve()
    expect('complete' in model && model.name).toBe('Other Cloud · borealis-flash')
  })

  it('a plan answers through its engine, on the smallest model the plan offers', async () => {
    const turns: string[] = []
    const { guide } = models(settingsOf([PLAN], 'plan1'), {
      planTurn: async (account, model, system, prompt) => {
        turns.push(`${account.id}|${model}|${system}|${prompt}`)
        return 'from the plan'
      },
    })
    const model = await guide.resolve()
    if (!('complete' in model)) throw new Error(model.message)
    expect(model.name).toBe('Some plan · tiny')
    expect(model.vision).toBe(false)
    expect(await model.complete('s', 'p')).toBe('from the plan')
    expect(turns).toEqual(['plan1|tiny|s|p'])
  })

  it('says plainly when there is nothing to think with', async () => {
    const none = await models(settingsOf([], '')).guide.resolve()
    expect(none).toEqual({ message: 'Add an AI account in Settings to be shown how.' })
    expect(await models(settingsOf([], '')).guide.describe()).toEqual({ ok: false, message: 'Add an AI account in Settings to be shown how.' })
  })

  it('a picture of his screen is written only for the call and deleted after, and a model that takes none is not shown one again', async () => {
    const seen: string[] = []
    let fail = false
    const dir = mkdtempSync(join(tmpdir(), 'agent-showme-pic-'))
    const provider: LlmProvider = {
      name: 'fake',
      complete: async (_system, messages) => {
        const image = messages[0]!.blocks.find((block) => block.t === 'image')
        if (image !== undefined && image.t === 'image') {
          seen.push(`${image.mime}:${existsSync(image.path)}`)
          if (fail) throw new Error('this model takes no pictures')
        }
        return { message: { role: 'ASSISTANT', blocks: [{ t: 'text', text: '{"none":true}' }] } as Msg, stopReason: 'end', usage: { input: 0, output: 0 } as never }
      },
    }
    const guide = new GuideModels({ settings: { get: () => settingsOf([KEYED], 'key1', { account: 'key1', model: 'atlas-mini' }) }, secrets: secretsFor('key1'), providerFactory: () => provider, hasCli: false, listModels: async () => [], tmpDir: dir })
    const model = await guide.resolve()
    if (!('complete' in model)) throw new Error(model.message)
    expect(model.vision).toBe(true)
    await model.complete('s', 'p', { image: Buffer.from('png bytes') })
    expect(seen).toEqual(['image/png:true'])
    expect(readdirSync(dir)).toEqual([])
    fail = true
    await expect(model.complete('s', 'p', { image: Buffer.from('png bytes') })).rejects.toThrow('takes no pictures')
    expect(readdirSync(dir)).toEqual([])
    expect(model.vision).toBe(false)
  })
})

interface Rig {
  screen: FakeScreen
  overlay: FakeOverlay
  model: FakeModel
  clipboard: FakeClipboard
  service: ShowMeService
  states: ShowMeState[]
  held: string[]
  released: string[]
  press(accelerator: string): void
}

const SKILL_ROW = { id: 'm1', kind: 'skill', title: 'Acme Desk: how to do anything (guided)', topics: 'acme desk', body: 'Site desk.acme-example.io. Create a pixel: `Automations`, `Create pixel`, field `Pixel name`, `Save pixel`.' }

function rig(options: { nodes?: ReturnType<typeof column>; deps?: Partial<ShowMeDeps>; model?: FakeModel | null } = {}): Rig {
  const screen = new FakeScreen(options.nodes ?? column(['Automations', 'Create pixel']))
  const overlay = new FakeOverlay()
  const model = options.model === undefined ? new FakeModel() : options.model
  const clipboard = new FakeClipboard()
  const states: ShowMeState[] = []
  const held: string[] = []
  const released: string[] = []
  const callbacks = new Map<string, () => void>()
  const service = new ShowMeService({
    reader: screen,
    overlay,
    model: async () => model ?? { message: 'Add an AI account in Settings to be shown how.' },
    sources: async () => skillSources([SKILL_ROW], []),
    clipboard,
    holdKey: (accelerator, callback) => {
      held.push(accelerator)
      callbacks.set(accelerator, callback)
      return () => void released.push(accelerator)
    },
    keys: () => ({ skip: 'CommandOrControl+Alt+Right', done: 'CommandOrControl+Alt+Down' }),
    formatKey: (accelerator) => accelerator.replace('CommandOrControl', 'Ctrl'),
    onState: (state) => void states.push(state),
    now: () => performance.now(),
    timings: { firstFindMs: 60, nextFindMs: 150, pollMs: 4, settleMs: 30, recheckMs: 20 },
    ...(options.deps ?? {}),
  })
  return { screen, overlay, model: model ?? new FakeModel(), clipboard, service, states, held, released, press: (accelerator) => callbacks.get(accelerator)?.() }
}

const ringOf = (r: Rig, label: string): Promise<void> => until(`the ring "${label}"`, () => r.overlay.current?.label.startsWith(label) === true)

describe('the quick chat bar starts a walk', () => {
  it('on the window that was in front when the shortcut fired, with the route from the matching skill page', async () => {
    const r = rig()
    r.model.plan = () => JSON.stringify({ steps: [{ label: 'Click Automations', name: 'Automations' }, { label: 'Click Create pixel', name: 'Create pixel' }] })
    // The shortcut fires: the window is noted. Then the bar opens and another window is "in front".
    await r.service.noteForeground()
    const browser = r.screen.win
    r.screen.win = { hwnd: 'elsewhere', pid: 5, process: 'other.exe', title: 'Something else', bounds: { x: 0, y: 0, width: 10, height: 10 } }
    const started = await r.service.ask('how do I create a pixel')
    expect(started).toEqual({ ok: true, message: '' })
    r.screen.win = browser
    await ringOf(r, 'Click Automations')
    // The first label names the keys, as the settings hold them.
    expect(r.overlay.current?.label).toBe('Click Automations (Esc stops, Ctrl+Alt+Right skips)')
    // The skill page was matched by the window, and the planner got it.
    const plan = r.model.calls.find((call) => call.kind === 'plan')!
    expect(plan.prompt).toContain('Skill page: Acme Desk: how to do anything (guided)')
    expect(plan.prompt).toContain('`Create pixel`')
    expect(plan.prompt).toContain('Window: Acme Desk - Google Chrome [chrome.exe]')
    // Esc and the two shortcuts are held only while the walk runs.
    expect(r.held).toEqual(['Escape', 'CommandOrControl+Alt+Right', 'CommandOrControl+Alt+Down'])
    expect(r.service.running()).toBe(true)
    expect(r.service.state()).toMatchObject({ running: true, phase: 'walking', step: 1, of: 2, question: 'how do I create a pixel' })
    r.screen.click('Automations')
    await ringOf(r, 'Click Create pixel')
    r.press('CommandOrControl+Alt+Down')
    await until('the walk to end', () => !r.service.running())
    expect(r.released).toEqual(['Escape', 'CommandOrControl+Alt+Right', 'CommandOrControl+Alt+Down'])
    expect(r.service.state()).toMatchObject({ running: false, phase: 'ended', message: 'Done: 2 steps.', failed: false })
    expect(r.states.map((state) => state.phase)).toContain('planning')
    expect(r.overlay.current).toBeNull()
  })

  it('Esc stops it from the held key', async () => {
    const r = rig()
    r.model.plan = () => JSON.stringify({ steps: [{ label: 'Click Automations', name: 'Automations' }, { label: 'Click Create pixel', name: 'Create pixel' }] })
    await r.service.ask('how do I create a pixel')
    await ringOf(r, 'Click Automations')
    r.press('Escape')
    await until('the walk to end', () => !r.service.running())
    expect(r.overlay.current).toBeNull()
    expect(r.service.state()).toMatchObject({ phase: 'ended', message: 'Stopped.' })
  })

  it('says why when it cannot start, and sends nothing anywhere', async () => {
    const none = rig({ deps: { reader: noScreenReader() } })
    expect(await none.service.ask('how do I create a pixel')).toEqual({ ok: false, message: NO_READER })
    expect(none.model.calls).toHaveLength(0)
    expect(none.service.state()).toMatchObject({ phase: 'ended', message: NO_READER })
    // The reader the app ships until the native layer lands is that one.
    expect(await appScreenReader().available()).toBe(false)

    const blank = rig()
    blank.screen.activeWindow = async () => null
    expect(await blank.service.ask('how do I create a pixel')).toEqual({ ok: false, message: NO_WINDOW })
    expect(await blank.service.ask('   ')).toEqual({ ok: false, message: 'Say what you want to be shown.' })
  })

  it('brings the bar back with the reason when no route could be worked out', async () => {
    const r = rig()
    r.model.plan = () => '{"steps":[],"note":"Open the Automations page first."}'
    await r.service.ask('how do I create a pixel')
    await until('the walk to end', () => r.states.at(-1)?.phase === 'ended')
    expect(r.states.at(-1)).toMatchObject({ failed: true, message: 'Open the Automations page first.' })

    const noModel = rig({ model: null })
    await noModel.service.ask('how do I create a pixel')
    await until('the walk to end', () => noModel.states.at(-1)?.phase === 'ended')
    expect(noModel.states.at(-1)).toMatchObject({ failed: true, message: 'Add an AI account in Settings to be shown how.' })
  })

  it('never holds the bar up waiting for the screen reader', async () => {
    const r = rig()
    r.screen.activeWindow = () => new Promise(() => undefined)
    const before = performance.now()
    await r.service.noteForeground(40)
    expect(performance.now() - before).toBeLessThan(400)
  })

  it('a new walk replaces the one before it', async () => {
    const r = rig()
    r.model.plan = () => JSON.stringify({ steps: [{ label: 'Click Automations', name: 'Automations' }] })
    await r.service.ask('how do I open automations')
    await ringOf(r, 'Click Automations')
    r.model.plan = () => JSON.stringify({ steps: [{ label: 'Click Create pixel', name: 'Create pixel' }] })
    await r.service.ask('how do I create a pixel')
    await ringOf(r, 'Click Create pixel')
    expect(r.overlay.rings.filter((ring) => ring.label.startsWith('Click Automations'))).toHaveLength(1)
    r.service.stop()
    await until('the walk to end', () => !r.service.running())
  })
})

describe('an agent starts a walk (screen_guide)', () => {
  const ctx = (signal = new AbortController().signal): ToolContext => ({ agentLabel: 'main', owner: 'main', activity: async () => 0, updateActivity: async () => undefined, ask: async () => null, approve: async () => true, notify: async () => undefined, signal })

  it('walks the steps it was given, with no model at all, and answers with what he did', async () => {
    const r = rig({ nodes: [node('a', 'Create pixel'), node('b', 'Pixel name', 'textbox', { x: 300, y: 300, width: 300, height: 36 }), node('c', 'Save pixel', 'button', { x: 300, y: 400, width: 120, height: 36 })], model: null })
    const [tool] = screenGuideTools({ showMe: () => r.service })
    const secret = 'made-up-vault-value-123'
    const answer = tool!.run(
      {
        question: 'create a pixel',
        steps: [
          { label: 'Click Create pixel', name: 'Create pixel', role: 'button' },
          { label: 'Paste the pixel name', name: 'Pixel name', role: 'textbox', value: secret, sensitive: true },
          { label: 'Click Save pixel', name: 'Save pixel' },
        ],
      },
      ctx(),
    )
    await ringOf(r, 'Click Create pixel')
    r.screen.click('Create pixel')
    await ringOf(r, 'Paste the pixel name')
    expect(r.clipboard.text).toBe(secret)
    expect(r.overlay.current?.fill).toEqual({ field: 'Pixel name', sensitive: true })
    r.screen.paste()
    await ringOf(r, 'Click Save pixel')
    expect(r.clipboard.text).toBe('')
    r.screen.click('Save pixel')
    const text = await answer
    expect(text).toContain('outcome: done')
    expect(text).toContain('He did all 3 steps himself.')
    expect(text).toContain('2. Paste the pixel name: pasted on textbox "Pixel name"')
    expect(text).toContain('clipboard cleared')
    expect(text).toContain('model calls: 0')
    expect(text).toContain('Window: Acme Desk - Google Chrome [chrome.exe] at https://desk.acme-example.io/home')
    // The secret is in nothing that comes back or is kept.
    expect(text).not.toContain(secret)
    const session = r.service.sessions.get('latest')!
    expect(JSON.stringify(session)).not.toContain(secret)
    expect(JSON.stringify(r.states)).not.toContain(secret)
    // The log is the in-app guide's own shape, so the same reader and the same "save as" path can take it.
    expect(session).toMatchObject({ owner: 'main', tabId: 'screen:w1', url: 'https://desk.acme-example.io/home', total: 3, current: 4 })
    expect(session.steps).toEqual([
      { label: 'Click Create pixel', target: { name: 'Create pixel', role: 'button' } },
      { label: 'Paste the pixel name', target: { name: 'Pixel name', role: 'textbox' } },
      { label: 'Click Save pixel', target: { name: 'Save pixel' } },
    ])
    expect(session.logs.map((log) => log.outcome)).toEqual(['clicked', 'typed', 'clicked'])
    expect(session.logs[1]).toMatchObject({ pasted: true, secret: true, clipboard: 'cleared' })
    expect(formatLog(session, [])).toContain('Step 2. Paste the pixel name: typed on textbox "Pixel name"')
  })

  it('plans from his question when no steps are given, on the window in front now', async () => {
    const r = rig()
    r.model.plan = () => JSON.stringify({ steps: [{ label: 'Click Automations', name: 'Automations' }] })
    const [tool] = screenGuideTools({ showMe: () => r.service })
    const answer = tool!.run({ question: 'open automations' }, ctx())
    await ringOf(r, 'Click Automations')
    r.screen.click('Automations')
    const text = await answer
    expect(text).toContain('outcome: done')
    expect(text).toContain('route: skill, model calls: 1')
    expect(text).toContain('Route from: Acme Desk: how to do anything (guided)')
  })

  it('ends with the run that started it', async () => {
    const r = rig({ model: null })
    const controller = new AbortController()
    const [tool] = screenGuideTools({ showMe: () => r.service })
    const answer = tool!.run({ question: 'x', steps: [{ name: 'Automations' }] }, ctx(controller.signal))
    await ringOf(r, 'Click Automations')
    controller.abort()
    expect(await answer).toContain('outcome: cancelled')
    expect(r.overlay.current).toBeNull()
  })

  it('refuses what it cannot walk, plainly', async () => {
    const r = rig({ model: null })
    const [tool] = screenGuideTools({ showMe: () => r.service })
    expect(await tool!.run({}, ctx())).toBe('Say what he wants to do (question), or give the steps.')
    expect(await tool!.run({ question: 'x', steps: [{ label: 'no name' }] }, ctx())).toBe('Step 1: say which element by its name on screen.')
    expect(await tool!.run({ question: 'x', steps: Array.from({ length: 21 }, () => ({ name: 'A' })) }, ctx())).toBe('At most 20 steps in one walk.')
    expect(await screenGuideTools({ showMe: () => null })[0]!.run({ question: 'x' }, ctx())).toContain('this device cannot do it')
    expect(await screenGuideTools({})[0]!.run({ question: 'x' }, ctx())).toContain('this device cannot do it')
    const none = rig({ deps: { reader: noScreenReader() } })
    expect(await screenGuideTools({ showMe: () => none.service })[0]!.run({ question: 'x' }, ctx())).toBe(NO_READER)
    await pause(5)
  })

  it('a Vault value in a step is sensitive before the tool ever sees it', () => {
    expect(VAULT_FILL_TOOLS.has('screen_guide')).toBe(true)
    const marked = markVaultSteps({ question: 'q', steps: [{ name: 'Key', value: '{{vault:some-key}}' }, { name: 'Name', value: 'plain' }] })
    expect(marked['steps']).toEqual([{ name: 'Key', value: '{{vault:some-key}}', sensitive: true }, { name: 'Name', value: 'plain' }])
  })

  it('is not a read-only tool: it is never cut off as if it only looked', async () => {
    const { isInterruptible } = await import('../src/main/runtime/read-only')
    expect(isInterruptible('screen_guide', { question: 'x' })).toBe(false)
    expect(isInterruptible('mcp__agent__screen_guide', {})).toBe(false)
  })
})

describe('what the bar says at the end', () => {
  it('one plain line', () => {
    const base = { completed: 0, total: 3, steps: [], route: [], replans: 0, modelCalls: 0, planned: 'skill' as const, note: '' }
    expect(endLine({ ...base, outcome: 'done' })).toBe('Done: 3 steps.')
    expect(endLine({ ...base, outcome: 'done', total: 1 })).toBe('Done: 1 step.')
    expect(endLine({ ...base, outcome: 'cancelled' })).toBe('Stopped.')
    expect(endLine({ ...base, outcome: 'cancelled', completed: 2 })).toBe('Stopped after 2 of 3 steps.')
    expect(endLine({ ...base, outcome: 'no_plan' })).toBe('I could not work out the steps for that on this window.')
    expect(endLine({ ...base, outcome: 'no_window' })).toBe(NO_WINDOW)
  })
})
