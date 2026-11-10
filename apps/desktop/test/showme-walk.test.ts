/**
 * The walk of "show me how" (main/showme/walk.ts), over a fake screen, a fake overlay and a fake model: his click in
 * the ring advances and a click elsewhere does not, a fill step puts the value on his clipboard and a secret is
 * cleared after his paste, Esc ends everything, Skip and I did it move on, a missing target is planned again a
 * couple of times and then said plainly, and the next step's element is looked up ahead so his click puts the next
 * ring up with no model call. The click-to-next-ring time is measured here, with and without a known route.
 */
import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import type { ShowStep } from '../src/main/showme/planner'
import type { ActiveWindow } from '../src/main/showme/screen'
import { PLANNING_LABEL, REST_HINT_MS, Walk, formatWalk, matchNode, missingLabel, roleKey, scrollHintRect, scrollLabel, scrollWay, type WalkDeps, type WalkKeys, type WalkResult } from '../src/main/showme/walk'
import { FakeClipboard, FakeModel, FakeOverlay, FakeScreen, WINDOW, column, node, pause, until } from './helpers/fake-screen'

const FAST = { firstFindMs: 80, nextFindMs: 200, pollMs: 4, settleMs: 40, recheckMs: 20, timeoutMs: 8_000, maxReplans: 2 }

function step(name: string, extra: Partial<ShowStep> = {}): ShowStep {
  return { label: `Click ${name}`, name, ...extra }
}

interface Rig {
  screen: FakeScreen
  overlay: FakeOverlay
  model: FakeModel
  clipboard: FakeClipboard
  keys: WalkKeys | null
  released: number
  walk: Walk
  done: Promise<WalkResult>
}

function start(options: { nodes: ReturnType<typeof column>; steps?: ShowStep[]; question?: string; skill?: string; model?: FakeModel | null; deps?: Partial<WalkDeps>; signal?: AbortSignal; window?: ActiveWindow }): Rig {
  const screen = new FakeScreen(options.nodes, options.window ?? WINDOW)
  const overlay = new FakeOverlay()
  const model = options.model === undefined ? new FakeModel() : options.model
  const clipboard = new FakeClipboard()
  const rig = { screen, overlay, model: model ?? new FakeModel(), clipboard, keys: null as WalkKeys | null, released: 0 } as Rig
  rig.walk = new Walk(
    {
      reader: screen,
      overlay,
      model,
      clipboard,
      now: () => performance.now(),
      timings: FAST,
      holdKeys: (keys) => {
        rig.keys = keys
        return () => {
          rig.released++
        }
      },
      ...(options.deps ?? {}),
    },
    { window: screen.win, question: options.question ?? 'how do I do it', ...(options.steps === undefined ? {} : { steps: options.steps }), ...(options.skill === undefined ? {} : { skill: options.skill }), ...(options.signal === undefined ? {} : { signal: options.signal }) },
  )
  rig.done = rig.walk.run()
  return rig
}

const ring = (rig: Rig, label: string): Promise<void> => until(`the ring "${label}"`, () => rig.overlay.current?.label === label)

describe('his click is the feedback', () => {
  it('advances on a click inside the ring, and not on a click anywhere else', async () => {
    const rig = start({ nodes: column(['Alpha', 'Beta']), steps: [step('Alpha'), step('Beta')] })
    await ring(rig, 'Click Alpha')
    expect(rig.overlay.current).toMatchObject({ step: 1, of: 2, rect: { x: 200, y: 200, width: 160, height: 40 } })

    // A click somewhere else is his own business: nothing moves, nothing is stopped.
    rig.screen.clickAt(900, 700)
    rig.screen.clickAt(205, 300, 'left') // on Beta, which is not the step
    await pause(40)
    expect(rig.overlay.current?.label).toBe('Click Alpha')
    // The other mouse buttons are not the step either.
    rig.screen.clickAt(280, 220, 'right')
    await pause(20)
    expect(rig.overlay.current?.label).toBe('Click Alpha')

    rig.screen.click('Alpha')
    await ring(rig, 'Click Beta')
    expect(rig.overlay.current).toMatchObject({ step: 2, of: 2 })
    rig.screen.click('Beta')
    const result = await rig.done
    expect(result.outcome).toBe('done')
    expect(result.completed).toBe(2)
    expect(result.steps.map((log) => log.outcome)).toEqual(['clicked', 'clicked'])
    expect(result.modelCalls).toBe(0)
    // Everything is put away: no ring, no listener on his input, no watcher, the keys let go.
    expect(rig.overlay.current).toBeNull()
    expect(rig.screen.listening).toBe(0)
    expect(rig.screen.watching).toBe(0)
    expect(rig.released).toBe(1)
  })

  it('takes a click a few pixels outside the element as a click on it, and follows the element when it moves', async () => {
    const rig = start({ nodes: column(['Alpha', 'Beta']), steps: [step('Alpha'), step('Beta')] })
    await ring(rig, 'Click Alpha')
    // The page scrolls: the ring follows without being drawn again.
    rig.screen.move('n1', { x: 200, y: 500, width: 160, height: 40 })
    expect(rig.overlay.moves.at(-1)).toEqual({ x: 200, y: 500, width: 160, height: 40 })
    // Where it used to be is no longer the step.
    rig.screen.clickAt(280, 220)
    await pause(20)
    expect(rig.overlay.current?.label).toBe('Click Alpha')
    rig.screen.clickAt(197, 497)
    await ring(rig, 'Click Beta')
    rig.walk.stop()
    await rig.done
  })

  it('finds the element again when the program re-draws it under him', async () => {
    const rig = start({ nodes: column(['Alpha', 'Beta']), steps: [step('Alpha'), step('Beta')] })
    await ring(rig, 'Click Alpha')
    const before = rig.overlay.shows.length
    // The page re-rendered: same button, new element, somewhere else.
    rig.screen.set([node('x9', 'Alpha', 'button', { x: 600, y: 80, width: 100, height: 30 }), node('n2', 'Beta')])
    await until('the ring on the new Alpha', () => rig.overlay.shows.length > before && rig.overlay.current?.rect.x === 600)
    rig.screen.click('Alpha')
    await ring(rig, 'Click Beta')
    rig.walk.stop()
    expect((await rig.done).steps[0]).toMatchObject({ n: 1, outcome: 'clicked' })
  })
})

describe('scrolling', () => {
  it('takes the ring down while the page scrolls and draws it again where the thing is, as the same step', async () => {
    const rig = start({ nodes: column(['Alpha', 'Beta']), steps: [step('Alpha'), step('Beta')] })
    await ring(rig, 'Click Alpha')
    const finds = rig.screen.calls.find.length
    // The wheel turns: the reader says the place is unknown for now. Again and again, as a long scroll does.
    for (let i = 0; i < 6; i++) rig.screen.rest('n1', 'scrolling')
    expect(rig.overlay.current).toBeNull()
    // A click where the ring used to be is not the step while it rests.
    rig.screen.clickAt(280, 220)
    await pause(30)
    expect(rig.overlay.current).toBeNull()
    // The page came to rest: the ring is back on the element, in its new place, with the same label.
    rig.screen.move('n1', { x: 200, y: 520, width: 160, height: 40 })
    expect(rig.overlay.current).toMatchObject({ label: 'Click Alpha', step: 1, rect: { x: 200, y: 520, width: 160, height: 40 } })
    // It was never looked for again, and it is not frozen: it still follows.
    expect(rig.screen.calls.find.length).toBe(finds)
    rig.screen.move('n1', { x: 200, y: 400, width: 160, height: 40 })
    expect(rig.overlay.current?.rect.y).toBe(400)
    rig.screen.clickAt(280, 420)
    await ring(rig, 'Click Beta')
    rig.walk.stop()
    const result = await rig.done
    expect(result.steps[0]).toMatchObject({ n: 1, outcome: 'clicked' })
    expect(result.modelCalls).toBe(0)
  })

  it('says which way to scroll when the thing stays out of sight, and rings it when it is in view again', async () => {
    const rig = start({ nodes: column(['Alpha', 'Beta']), steps: [step('Alpha'), step('Beta')] })
    await ring(rig, 'Click Alpha')
    // He scrolled it off the top of the window.
    rig.screen.nodes[0]!.offscreen = true
    rig.screen.nodes[0]!.bounds = { x: 200, y: -300, width: 160, height: 40 }
    rig.screen.rest('n1', 'hidden')
    expect(rig.overlay.current).toBeNull()
    await until('the scroll hint', () => rig.overlay.current?.label === scrollLabel({ name: 'Alpha' }, 'up'), REST_HINT_MS + 1_000)
    expect(rig.overlay.current).toMatchObject({ step: 1, of: 2, rect: scrollHintRect(WINDOW.bounds, 'up') })
    // A click on the hint's bar is not the step.
    rig.screen.clickAt(WINDOW.bounds.width / 2, scrollHintRect(WINDOW.bounds, 'up').y + 2)
    await pause(20)
    expect(rig.overlay.current?.label).toBe(scrollLabel({ name: 'Alpha' }, 'up'))
    rig.screen.nodes[0]!.offscreen = false
    rig.screen.move('n1', { x: 200, y: 240, width: 160, height: 40 })
    expect(rig.overlay.current).toMatchObject({ label: 'Click Alpha', rect: { y: 240 } })
    rig.screen.clickAt(280, 260)
    await ring(rig, 'Click Beta')
    rig.walk.stop()
    await rig.done
  })

  it('looks for the thing again when it is really gone after a rest', async () => {
    const rig = start({ nodes: column(['Alpha', 'Beta']), steps: [step('Alpha'), step('Beta')] })
    await ring(rig, 'Click Alpha')
    rig.screen.rest('n1', 'hidden')
    // The page drew itself again meanwhile: a new element of the same name, elsewhere. The old one never comes back.
    rig.screen.set([node('x9', 'Alpha', 'button', { x: 640, y: 90, width: 100, height: 30 }), node('n2', 'Beta')])
    await until('the ring on the new Alpha', () => rig.overlay.current?.label === 'Click Alpha' && rig.overlay.current.rect.x === 640, REST_HINT_MS + 1_000)
    rig.screen.click('Alpha')
    await ring(rig, 'Click Beta')
    rig.walk.stop()
    await rig.done
  })

  it('asks no model and plans nothing again for a step that is below the fold: it says scroll down, then rings it', async () => {
    const below = node('n2', 'Beta', 'button', { x: 200, y: 1_600, width: 160, height: 40 }, { offscreen: true })
    const rig = start({ nodes: [node('n1', 'Alpha', 'button', { x: 200, y: 200, width: 160, height: 40 }), below], steps: [step('Alpha'), step('Beta')] })
    rig.model.plan = () => '{"steps":[{"label":"Click Gamma","name":"Gamma"}]}'
    await ring(rig, 'Click Alpha')
    const at = rig.screen.click('Alpha')
    await ring(rig, scrollLabel({ name: 'Beta' }, 'down'))
    const hintMs = rig.overlay.shows.at(-1)!.t - at
    console.log(`[showme] click to the scroll hint for a step below the fold: ${hintMs.toFixed(1)} ms, model calls ${rig.model.calls.length}`)
    expect(hintMs).toBeLessThan(250)
    expect(rig.overlay.current).toMatchObject({ step: 2, of: 2, rect: scrollHintRect(WINDOW.bounds, 'down') })
    expect(rig.model.calls).toHaveLength(0)
    // He scrolls; it comes into view.
    rig.screen.set([node('n1', 'Alpha', 'button', { x: 200, y: -900, width: 160, height: 40 }, { offscreen: true }), node('n2', 'Beta', 'button', { x: 200, y: 500, width: 160, height: 40 })])
    await until('the real ring', () => rig.overlay.current?.label === 'Click Beta' && rig.overlay.current.rect.y === 500)
    rig.screen.click('Beta')
    const result = await rig.done
    expect(result).toMatchObject({ outcome: 'done', completed: 2, replans: 0, modelCalls: 0 })
  })

  it('reads the way from where the thing is', () => {
    const window = { x: 0, y: 0, width: 1_600, height: 1_000 }
    expect(scrollWay({ x: 10, y: 1_400, width: 100, height: 30 }, window)).toBe('down')
    expect(scrollWay({ x: 10, y: -400, width: 100, height: 30 }, window)).toBe('up')
    expect(scrollWay({ x: 10, y: 400, width: 100, height: 30 }, window)).toBe('to')
    expect(scrollWay({ x: 0, y: 0, width: 0, height: 0 }, window)).toBe('to')
    expect(scrollLabel({ name: 'Add reviewer' }, 'down')).toBe('Scroll down to "Add reviewer"')
    expect(scrollLabel({ name: 'Add reviewer' }, 'to')).toBe('Scroll to "Add reviewer"')
  })
})

describe('Esc, Skip and I did it', () => {
  it('Esc ends the walk and hides everything, whichever way it arrives', async () => {
    for (const how of ['key', 'hook', 'signal', 'stop'] as const) {
      const controller = new AbortController()
      const rig = start({ nodes: column(['Alpha', 'Beta']), steps: [step('Alpha'), step('Beta')], signal: controller.signal })
      await ring(rig, 'Click Alpha')
      if (how === 'key') rig.keys?.stop()
      if (how === 'hook') rig.screen.key('Escape')
      if (how === 'signal') controller.abort()
      if (how === 'stop') rig.walk.stop()
      // The ring is gone at once, not when the loop gets round to it.
      expect(rig.overlay.current).toBeNull()
      const result = await rig.done
      expect(result.outcome).toBe('cancelled')
      expect(result.completed).toBe(0)
      expect(rig.overlay.ops.at(-1)).toBe('hide')
      expect(rig.screen.listening).toBe(0)
      expect(rig.screen.watching).toBe(0)
      expect(rig.released).toBe(1)
      // Nothing is drawn after the end, even though his clicks go on.
      const shows = rig.overlay.shows.length
      rig.screen.click('Alpha')
      await pause(20)
      expect(rig.overlay.shows.length).toBe(shows)
    }
  })

  it('Skip moves to the next step without him doing this one; I did it too', async () => {
    const rig = start({ nodes: column(['Alpha', 'Beta', 'Gamma']), steps: [step('Alpha'), step('Beta'), step('Gamma')] })
    await ring(rig, 'Click Alpha')
    rig.keys?.skip()
    await ring(rig, 'Click Beta')
    // The label's own button.
    rig.overlay.current?.onAct?.('done')
    await ring(rig, 'Click Gamma')
    rig.overlay.current?.onAct?.('skipped')
    const result = await rig.done
    expect(result.outcome).toBe('done')
    expect(result.steps.map((log) => log.outcome)).toEqual(['skipped', 'done', 'skipped'])
  })

  it('tells the first label the keys, once', async () => {
    const rig = start({ nodes: column(['Alpha', 'Beta']), steps: [step('Alpha'), step('Beta')], deps: { keyHint: 'Esc stops, Ctrl+Alt+Right skips' } })
    await ring(rig, 'Click Alpha (Esc stops, Ctrl+Alt+Right skips)')
    rig.screen.click('Alpha')
    await ring(rig, 'Click Beta')
    rig.walk.stop()
    await rig.done
  })

  it('times out by itself', async () => {
    const rig = start({ nodes: column(['Alpha']), steps: [step('Alpha')], deps: { timings: { ...FAST, timeoutMs: 60 } } })
    const result = await rig.done
    expect(result.outcome).toBe('timeout')
    expect(rig.overlay.current).toBeNull()
  })
})

describe('clipboard fill', () => {
  const fields = [node('n1', 'Pixel name', 'textbox', { x: 300, y: 300, width: 300, height: 36 }), node('n2', 'Save', 'button', { x: 300, y: 400, width: 100, height: 36 })]

  it('puts a known value on his clipboard, says so, and advances on his paste; his own clipboard comes back', async () => {
    const rig = start({ nodes: fields, steps: [{ label: 'Paste the pixel name', name: 'Pixel name', role: 'textbox', value: 'Northwind' }, step('Save')] })
    rig.clipboard.text = 'what he had copied'
    await ring(rig, 'Paste the pixel name')
    expect(rig.clipboard.text).toBe('Northwind')
    expect(rig.overlay.current?.fill).toEqual({ field: 'Pixel name', value: 'Northwind' })
    // His click into the field is not the step.
    rig.screen.click('Pixel name')
    await pause(20)
    expect(rig.overlay.current?.label).toBe('Paste the pixel name')
    rig.screen.paste()
    await ring(rig, 'Click Save')
    expect(rig.clipboard.text).toBe('what he had copied')
    rig.screen.click('Save')
    const result = await rig.done
    expect(result.steps[0]).toMatchObject({ outcome: 'pasted', clipboard: 'restored' })
  })

  it('never shows a sensitive value, and clears the clipboard after his paste', async () => {
    const secret = 'sk-made-up-0123456789'
    const rig = start({ nodes: fields, steps: [{ label: 'Paste the key', name: 'Pixel name', value: secret, sensitive: true }, step('Save')] })
    await ring(rig, 'Paste the key')
    expect(rig.clipboard.text).toBe(secret)
    // The overlay is told the field and that it is secret: never the value.
    expect(rig.overlay.current?.fill).toEqual({ field: 'Pixel name', sensitive: true })
    expect(JSON.stringify(rig.overlay.shows)).not.toContain(secret)
    rig.screen.key('v', { ctrl: true })
    await ring(rig, 'Click Save')
    expect(rig.clipboard.text).toBe('')
    expect(rig.clipboard.cleared).toBe(1)
    rig.screen.click('Save')
    const result = await rig.done
    expect(result.steps[0]).toMatchObject({ outcome: 'pasted', clipboard: 'cleared', secret: true })
    // Nothing the walk hands back holds it.
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(formatWalk(result)).not.toContain(secret)
  })

  it('clears a sensitive value when the walk is stopped before he pastes', async () => {
    const rig = start({ nodes: fields, steps: [{ label: 'Paste the key', name: 'Pixel name', value: 'made-up-secret', sensitive: true }] })
    await ring(rig, 'Paste the key')
    expect(rig.clipboard.text).toBe('made-up-secret')
    rig.keys?.stop()
    await rig.done
    expect(rig.clipboard.text).toBe('')
  })

  it('takes his own typing as the step once he leaves the field', async () => {
    const rig = start({ nodes: fields, steps: [{ label: 'Paste the pixel name', name: 'Pixel name', value: 'Northwind' }, step('Save')] })
    await ring(rig, 'Paste the pixel name')
    rig.screen.click('Pixel name')
    for (const key of 'North') rig.screen.key(key)
    await pause(15)
    expect(rig.overlay.current?.label).toBe('Paste the pixel name')
    rig.screen.key('Tab')
    await ring(rig, 'Click Save')
    rig.walk.stop()
    expect((await rig.done).steps[0]).toMatchObject({ outcome: 'typed' })
  })
})

describe('the next ring is ready before he clicks', () => {
  it('needs no model call and no wait between his click and the next ring when the route is known', async () => {
    const names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']
    const rig = start({ nodes: column(names), steps: names.map((name) => step(name)) })
    const gaps: number[] = []
    for (let i = 0; i < names.length; i++) {
      await ring(rig, `Click ${names[i]}`)
      // He takes a moment to read the label; the element after this one is looked up meanwhile.
      await pause(25)
      const clicked = rig.screen.click(names[i]!)
      if (i + 1 < names.length) {
        await ring(rig, `Click ${names[i + 1]}`)
        gaps.push(rig.overlay.current!.t - clicked)
      }
    }
    const result = await rig.done
    expect(result.outcome).toBe('done')
    expect(result.modelCalls).toBe(0)
    expect(rig.model.calls).toHaveLength(0)
    // Every ring after the first was looked up ahead of his click.
    expect(result.steps.slice(1).map((log) => log.how)).toEqual(['prefetch', 'prefetch', 'prefetch', 'prefetch'])
    const worst = Math.max(...gaps)
    console.log(`click to next ring, route known and next element on screen: worst ${worst.toFixed(1)} ms, all ${gaps.map((gap) => gap.toFixed(1)).join(', ')}`)
    expect(worst).toBeLessThan(50)
    // The ring is never taken down between two steps that follow at once: no flash of nothing.
    expect(rig.overlay.ops.join(' ')).not.toMatch(/show:Click Alpha hide show:Click Beta/)
    // The walk's own account of it agrees.
    for (const log of result.steps.slice(1)) expect(log.ringMs).toBeLessThan(50)
  })

  it('rings an element that only appears after his click (a menu opening) well inside half a second, with no model', async () => {
    const rig = start({ nodes: [node('m1', 'File')], steps: [step('File'), step('Export'), step('PDF')] })
    // The program takes a moment to open each menu.
    rig.screen.after('File', () => void setTimeout(() => rig.screen.set([node('m1', 'File'), node('m2', 'Export', 'menuitem', { x: 100, y: 160, width: 160, height: 30 })]), 30))
    rig.screen.after('Export', () => void setTimeout(() => rig.screen.set([node('m1', 'File'), node('m2', 'Export', 'menuitem'), node('m3', 'PDF', 'menuitem', { x: 280, y: 160, width: 120, height: 30 })]), 30))
    const gaps: number[] = []
    await ring(rig, 'Click File')
    let clicked = rig.screen.click('File')
    await ring(rig, 'Click Export')
    gaps.push(rig.overlay.current!.t - clicked)
    clicked = rig.screen.click('Export')
    await ring(rig, 'Click PDF')
    gaps.push(rig.overlay.current!.t - clicked)
    rig.screen.click('PDF')
    const result = await rig.done
    expect(result.modelCalls).toBe(0)
    console.log(`click to next ring, route known, element appears 30 ms after the click: ${gaps.map((gap) => gap.toFixed(1)).join(', ')} ms`)
    for (const gap of gaps) expect(gap).toBeLessThan(500)
    for (const gap of gaps) expect(gap).toBeLessThan(120)
  })

  it('checks a ring that was looked up ahead against the screen as it is after his click', async () => {
    // "Next" is on screen now, and his click on Start replaces it with another Next somewhere else.
    const rig = start({ nodes: [node('a', 'Start'), node('b', 'Next', 'button', { x: 500, y: 100, width: 100, height: 40 })], steps: [step('Start'), step('Next')] })
    rig.screen.after('Start', () => rig.screen.set([node('c', 'Next', 'button', { x: 900, y: 600, width: 100, height: 40 })]))
    await ring(rig, 'Click Start')
    await pause(20)
    rig.screen.click('Start')
    await until('the ring on the Next that is really there', () => rig.overlay.current?.label === 'Click Next' && rig.overlay.current.rect.x === 900)
    rig.screen.click('Next')
    expect((await rig.done).outcome).toBe('done')
  })
})

describe('the route: planned from a skill, picked by the model only when a name misses', () => {
  it('plans once from the skill page and then walks with no further model call', async () => {
    const model = new FakeModel()
    model.plan = () => JSON.stringify({ steps: [{ label: 'Click More options', name: 'More options', role: 'button' }, { label: 'Click Settings', name: 'Settings', role: 'menuitem' }, { label: 'Click Members', name: 'Members' }] })
    const rig = start({ nodes: [node('a', 'More options')], model, skill: 'Skill page: Acme Desk\nSettings is a dialog: `More options` then `Settings`, then `Members`.', question: 'how do I invite someone' })
    rig.screen.after('More options', () => rig.screen.set([node('a', 'More options'), node('b', 'Settings', 'menuitem', { x: 100, y: 300, width: 140, height: 30 })]))
    rig.screen.after('Settings', () => rig.screen.set([node('c', 'Members', 'tab', { x: 400, y: 200, width: 120, height: 30 })]))
    // He is told the one time he has to wait.
    expect(rig.overlay.shows[0]?.label ?? PLANNING_LABEL).toBe(PLANNING_LABEL)
    await ring(rig, 'Click More options')
    rig.screen.click('More options')
    await ring(rig, 'Click Settings')
    rig.screen.click('Settings')
    await ring(rig, 'Click Members')
    rig.screen.click('Members')
    const result = await rig.done
    expect(result).toMatchObject({ outcome: 'done', planned: 'skill', replans: 0, modelCalls: 1 })
    expect(model.count('plan')).toBe(1)
    expect(model.count('pick')).toBe(0)
    // The planner was given the skill, the question, the window and the elements.
    const prompt = model.calls[0]!.prompt
    expect(prompt).toContain('Skill page (the route to follow)')
    expect(prompt).toContain('how do I invite someone')
    expect(prompt).toContain('desk.acme-example.io')
    expect(prompt).toContain('a | button | More options')
  })

  it('asks the small model which element a step means when its name is not on screen, as soon as the screen has settled', async () => {
    const model = new FakeModel()
    model.delayMs = 150
    model.plan = () => JSON.stringify({ steps: [{ label: 'Open the new pixel form', name: 'New pixel' }, { label: 'Save it', name: 'Store pixel' }] })
    // The names the plan guessed are not the names on screen: the model is asked for each.
    model.pick = (prompt) => (prompt.includes('New pixel') ? 'n1' : 'n2')
    const rig = start({ nodes: [node('n1', 'Create a pixel'), node('n2', 'Save', 'button', { x: 500, y: 500, width: 90, height: 36 })], model })
    await ring(rig, 'Open the new pixel form')
    const clicked = rig.screen.click('Create a pixel')
    await ring(rig, 'Save it')
    const gap = rig.overlay.current!.t - clicked
    rig.screen.click('Save')
    const result = await rig.done
    expect(result).toMatchObject({ outcome: 'done', planned: 'model' })
    expect(result.steps.map((log) => log.how)).toEqual(['model', 'model'])
    expect(model.count('pick')).toBe(2)
    console.log(`click to next ring, no skill route, the model picks the element (fake model answers in 150 ms, screen settles in ${FAST.settleMs} ms): ${gap.toFixed(1)} ms`)
    // The wait is the settle time plus the model's own answer, not the whole time an element is given to appear.
    expect(gap).toBeGreaterThan(150)
    expect(gap).toBeLessThan(150 + FAST.settleMs + 120)
  })

  it('plans again from the screen when a target is missing, and carries on', async () => {
    const model = new FakeModel()
    model.plan = (_prompt, n) =>
      n === 1
        ? JSON.stringify({ steps: [{ label: 'Click Alpha', name: 'Alpha' }, { label: 'Click the old button', name: 'Legacy export' }, { label: 'Click Gamma', name: 'Gamma' }] })
        : JSON.stringify({ steps: [{ label: 'Click Beta', name: 'Beta' }, { label: 'Click Gamma', name: 'Gamma' }] })
    const rig = start({ nodes: column(['Alpha', 'Beta', 'Gamma']), model })
    await ring(rig, 'Click Alpha')
    rig.screen.click('Alpha')
    await ring(rig, 'Click Beta')
    rig.screen.click('Beta')
    await ring(rig, 'Click Gamma')
    rig.screen.click('Gamma')
    const result = await rig.done
    expect(result).toMatchObject({ outcome: 'done', replans: 1 })
    expect(result.route.map((each) => each.name)).toEqual(['Alpha', 'Beta', 'Gamma'])
    // The second plan was told what he had done and what was missing.
    const again = model.calls.filter((call) => call.kind === 'plan')[1]!.prompt
    expect(again).toContain('Already done by the person, in order: "Click Alpha"')
    expect(again).toContain('expected "Legacy export" next, and it is not on screen')
  })

  it('after a couple of re-plans says what it could not find, and he can still do it and say so', async () => {
    const model = new FakeModel()
    model.plan = () => JSON.stringify({ steps: [{ label: 'Click the missing thing', name: 'Nowhere' }, { label: 'Click Beta', name: 'Beta' }] })
    const rig = start({ nodes: column(['Alpha', 'Beta']), model })
    await ring(rig, missingLabel({ name: 'Nowhere' }))
    expect(model.count('plan')).toBe(3) // the plan, and two more tries
    // The ring is on the window itself, since there is nothing to point at.
    expect(rig.overlay.current?.rect).toEqual(WINDOW.bounds)
    // A click in the window is not "the step": only he can say he did it.
    rig.screen.clickAt(800, 500)
    await pause(20)
    expect(rig.overlay.current?.label).toBe(missingLabel({ name: 'Nowhere' }))
    rig.overlay.current?.onAct?.('done')
    await ring(rig, 'Click Beta')
    rig.screen.click('Beta')
    const result = await rig.done
    expect(result).toMatchObject({ outcome: 'done', replans: 2 })
    expect(result.steps[0]).toMatchObject({ outcome: 'done', how: 'none' })
  })

  it('puts the ring where it belongs when the missing thing turns up late (a slow page)', async () => {
    const rig = start({ nodes: [node('x', 'Loading')], steps: [step('Dashboard')], model: null })
    await ring(rig, missingLabel({ name: 'Dashboard' }))
    rig.screen.set([node('d', 'Dashboard', 'link', { x: 40, y: 120, width: 180, height: 32 })])
    await until('the real ring', () => rig.overlay.current?.label === 'Click Dashboard' && rig.overlay.current.rect.x === 40)
    rig.screen.click('Dashboard')
    expect((await rig.done).outcome).toBe('done')
  })

  it('falls back to a picture of the window when the program exposes no elements', async () => {
    const model = new FakeModel()
    model.vision = true
    // The picture is 800 by 500 of a window 1600 by 1000 at 100,50: a box in the picture is twice as big on screen.
    model.locate = () => '{"x":100,"y":200,"width":50,"height":20}'
    const window: ActiveWindow = { ...WINDOW, hwnd: 'canvas', bounds: { x: 100, y: 50, width: 1600, height: 1000 } }
    const rig = start({ nodes: [], steps: [step('Brush tool')], model, window })
    await ring(rig, 'Click Brush tool')
    expect(rig.overlay.current?.rect).toEqual({ x: 300, y: 450, width: 100, height: 40 })
    expect(model.calls.at(-1)).toMatchObject({ kind: 'locate', image: true })
    rig.screen.clickAt(340, 470)
    const result = await rig.done
    expect(result.steps[0]).toMatchObject({ outcome: 'clicked', how: 'vision' })
  })

  it('has no plan to offer without a model, and says so', async () => {
    const rig = start({ nodes: column(['Alpha']), model: null })
    const result = await rig.done
    expect(result.outcome).toBe('no_plan')
    expect(result.note).toContain('no model')
    expect(rig.overlay.rings).toHaveLength(0)
  })
})

describe('what leaves the computer', () => {
  it('never puts an element value in a prompt', async () => {
    const model = new FakeModel()
    model.plan = () => JSON.stringify({ steps: [{ label: 'Open billing', name: 'Invoices area' }] })
    model.pick = () => 'n2'
    const nodes = [node('n1', 'Card number', 'textbox', { x: 10, y: 10, width: 200, height: 30 }, { value: '4111 1111 1111 1111' }), node('n2', 'Billing', 'link', { x: 10, y: 60, width: 100, height: 30 }, { value: 'private-note-xyz' })]
    const rig = start({ nodes, model })
    await ring(rig, 'Open billing')
    rig.walk.stop()
    await rig.done
    expect(model.calls.length).toBeGreaterThanOrEqual(2)
    for (const call of model.calls) {
      expect(call.prompt).not.toContain('4111')
      expect(call.prompt).not.toContain('private-note-xyz')
    }
  })

  it('reads nothing of another program he switches to, hides the ring, and brings it back when he returns', async () => {
    const model = new FakeModel()
    const rig = start({ nodes: column(['Alpha', 'Beta']), steps: [step('Alpha'), step('Beta')], model })
    await ring(rig, 'Click Alpha')
    const mail: ActiveWindow = { hwnd: 'mail', pid: 777, process: 'mail.exe', title: 'Inbox', bounds: { x: 0, y: 0, width: 1200, height: 800 } }
    rig.screen.front(mail, [node('z', 'Alpha'), node('s', 'Secret subject line')])
    await until('the ring to hide', () => rig.overlay.current === null)
    await pause(60)
    // Not one read of the other program, and no model call about it.
    expect(rig.screen.calls.tree.filter((hwnd) => hwnd === 'mail')).toHaveLength(0)
    expect(rig.screen.calls.find.filter((call) => call.startsWith('mail:'))).toHaveLength(0)
    expect(model.calls).toHaveLength(0)
    expect(rig.overlay.current).toBeNull()
    rig.screen.front(WINDOW)
    await ring(rig, 'Click Alpha')
    rig.screen.click('Alpha')
    await ring(rig, 'Click Beta')
    rig.walk.stop()
    await rig.done
  })

  it('goes on in a window his own click opened', async () => {
    const rig = start({ nodes: column(['Open file']), steps: [step('Open file'), step('Documents')] })
    const dialog: ActiveWindow = { hwnd: 'dlg', pid: 4242, process: 'picker.exe', title: 'Open', bounds: { x: 300, y: 200, width: 800, height: 500 } }
    rig.screen.after('Open file', () => rig.screen.front(dialog, [node('d1', 'Documents', 'listitem', { x: 320, y: 260, width: 200, height: 28 })]))
    await ring(rig, 'Click Open file')
    rig.screen.click('Open file')
    await until('the ring in the dialog', () => rig.overlay.current?.label === 'Click Documents' && rig.overlay.current.rect.x === 320)
    rig.screen.click('Documents')
    expect((await rig.done).outcome).toBe('done')
  })
})

describe('matching a step to an element with no model', () => {
  const nodes = [node('a', 'Save', 'Button'), node('b', 'Save as...', 'MenuItem'), node('c', 'Email address', 'Edit'), node('d', 'Delete', 'button', undefined, { enabled: false }), node('e', 'Delete', 'button'), node('f', 'Hidden', 'button', undefined, { offscreen: true })]

  it('takes the exact name before a longer one that contains it', () => {
    expect(matchNode({ name: 'save' }, nodes)).toMatchObject({ node: { id: 'a' }, sure: true })
    expect(matchNode({ name: 'Save as' }, nodes)).toMatchObject({ node: { id: 'b' }, sure: true })
  })

  it('reads the kinds of control the system names in its own words', () => {
    expect(roleKey('Edit')).toBe('textbox')
    expect(roleKey('SplitButton')).toBe('button')
    expect(roleKey('Hyperlink')).toBe('link')
    expect(roleKey('TabItem')).toBe('tab')
    expect(matchNode({ name: 'Email', role: 'textbox' }, nodes)).toMatchObject({ node: { id: 'c' }, sure: true })
  })

  it('is not sure when several share the name, unless told which', () => {
    expect(matchNode({ name: 'Delete' }, nodes)).toMatchObject({ node: { id: 'e' }, sure: false })
    expect(matchNode({ name: 'Delete', nth: 1 }, nodes)).toMatchObject({ node: { id: 'd' }, sure: true })
  })

  it('never matches what is off screen, or nothing at all', () => {
    expect(matchNode({ name: 'Hidden' }, nodes)).toBeNull()
    expect(matchNode({ name: 'Publish' }, nodes)).toBeNull()
    expect(matchNode({ name: '' }, nodes)).toBeNull()
  })
})
