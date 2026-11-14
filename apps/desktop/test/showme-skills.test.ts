/**
 * Where a walk's route comes from (main/showme/skills.ts) and what the small model is asked (planner.ts). The skill
 * fixture is modelled on a real skill page an agent wrote for a web product (a map of the sidebar, playbooks with the
 * exact element names in backticks, gotchas such as "Settings is a dialog, its address is a 404"), with made-up
 * content: nothing in the product code knows any product by name.
 */
import { describe, expect, it } from 'vitest'

import { howToQuestion } from '../src/shared/showme'
import { LOCATE_SYSTEM, PLAN_SYSTEM, formatNodes, locatePrompt, parseBox, parsePick, parsePlan, pickPrompt, planPrompt, pngSize, stepFrom } from '../src/main/showme/planner'
import { MAX_SKILL_CHARS, hostOfUrl, hostsIn, matchSkill, skillSources, skillText, words, type AppLike, type MemoryLike } from '../src/main/showme/skills'
import { fakePng, node } from './helpers/fake-screen'

const ACME_SKILL: MemoryLike = {
  id: 'm-acme',
  kind: 'skill',
  title: 'Acme Desk: how to do anything (guided)',
  topics: 'acme desk, helpdesk, skill, how-to, guided, admin',
  aliases: 'AcmeDesk, Acme helpdesk',
  body: [
    'How any agent drives the real Acme Desk product (desk.acme-example.io, by Acme Example) and its Learning Hub. Full reference: `C:\\Users\\someone\\Downloads\\Acme\\AcmeDesk-skill.md`; lesson in `LESSON.md`.',
    '',
    '## Sign in',
    'Auth at login.acme-example.io. A magic link works: read the "Your sign-in link" mail and follow it.',
    '',
    '## Map',
    'Sidebar: Overview `/`, Inbox `/inbox`, Automations `/automations`, Library `/library`; Teams (+ = `Create new team`); footer Help `/help`, Learning Hub `/learn`, More options (the only door to Settings). Ctrl+K palette.',
    '',
    '## Settings (a dialog, no page)',
    'More options then Settings menuitem. Sections: Account, Members (`Invite`, per member `Role for <name>`), Billing, Appearance.',
    'Invite form: `Email address`, `Role` combobox, `Cancel`, `Send Invite`.',
    '',
    '## Playbooks',
    '- Create a pixel: Automations, `Create pixel`, field `Pixel name`, then `Save pixel`.',
    '- Add knowledge: Library, `Add knowledge` gives `Document Upload a file`, `Website Add a link`, `Note Write it here`.',
    '',
    '## Gotchas',
    '- `/settings` is a 404 page; never send a Settings URL, give the path: More options then Settings.',
    '- Many controls are icon only but named: `Create new team`, `More options`, `Toggle theme`.',
  ].join('\n'),
}

const SPREADSHEET_HOWTO: MemoryLike = { id: 'm-sheet', kind: 'how-to', title: 'Gridline: export a sheet as PDF', topics: 'gridline, spreadsheet, export', body: 'In Gridline (the desktop program): File, `Export`, `PDF`, then `Save`.' }
const CLOSED: MemoryLike = { id: 'm-old', kind: 'skill', title: 'Acme Desk: the old way', topics: 'acme desk', body: 'Out of date. desk.acme-example.io', status: 'closed' }
const PERSON: MemoryLike = { id: 'm-p', kind: 'person', title: 'Someone at Acme Desk', body: 'Works on desk.acme-example.io', topics: 'acme desk' }
const APP: AppLike = { id: 'tallybooks', name: 'TallyBooks', startUrl: 'https://app.tallybooks-example.com', about: 'Invoices and quotes. New invoice: `New`, `Invoice`, pick the customer, `Add line`, `Send`.' }

const SOURCES = skillSources([ACME_SKILL, SPREADSHEET_HOWTO, CLOSED, PERSON], [APP])

describe('which pages can be a route', () => {
  it('takes open skill and how-to pages and learned apps, nothing else', () => {
    expect(SOURCES.map((source) => source.id)).toEqual(['m-acme', 'm-sheet', 'tallybooks'])
    expect(SOURCES[0]).toMatchObject({ kind: 'memory', skill: true })
    expect(SOURCES[2]).toMatchObject({ kind: 'app', url: 'https://app.tallybooks-example.com' })
  })

  it('reads the addresses a page mentions, in backticks, brackets and sentences, and not its file names', () => {
    expect(hostsIn(ACME_SKILL.body)).toEqual(['desk.acme-example.io', 'login.acme-example.io'])
    expect(hostsIn('Open `portal.example.org`, then (https://www.example.net/path).')).toEqual(['portal.example.org', 'example.net'])
    expect(hostOfUrl('https://www.Desk.Acme-Example.io/inbox?x=1')).toBe('desk.acme-example.io')
    expect(hostOfUrl(undefined)).toBe('')
  })

  it('drops the words that say nothing about which program a window is', () => {
    expect(words('How do I create a pixel - Google Chrome')).toEqual(['create', 'pixel'])
  })
})

describe('finding the skill for the window he is on', () => {
  it('by the page address, whatever the title says', () => {
    const match = matchSkill(SOURCES, { process: 'chrome.exe', title: 'Inbox (3) - Google Chrome', url: 'https://desk.acme-example.io/inbox' }, 'how do I invite a member')
    expect(match?.source.id).toBe('m-acme')
    expect(match?.why.join(' ')).toContain('address desk.acme-example.io')
  })

  it('by the window title when the browser gives no address', () => {
    const match = matchSkill(SOURCES, { process: 'msedge.exe', title: 'Acme Desk - Automations - Microsoft Edge' }, 'how do I create a pixel')
    expect(match?.source.id).toBe('m-acme')
    expect(match?.why.join(' ')).toContain('window:')
  })

  it('by the program, for a desktop program', () => {
    const match = matchSkill(SOURCES, { process: 'Gridline.exe', title: 'Budget 2026.grid' }, 'how do I export this as PDF')
    expect(match?.source.id).toBe('m-sheet')
  })

  it('a learned app by where it lives', () => {
    const match = matchSkill(SOURCES, { process: 'firefox.exe', title: 'Invoices', url: 'https://app.tallybooks-example.com/invoices' }, 'how do I send an invoice')
    expect(match?.source.id).toBe('tallybooks')
  })

  it('by the question naming it clearly, when the window says nothing', () => {
    const match = matchSkill(SOURCES, { process: 'explorer.exe', title: 'Desktop' }, 'show me how to add knowledge in acme desk')
    expect(match?.source.id).toBe('m-acme')
  })

  it('nothing, rather than a wrong route: an unrelated window whose question merely shares a word', () => {
    expect(matchSkill(SOURCES, { process: 'chrome.exe', title: 'Weather - Google Chrome', url: 'https://weather.example.com' }, 'how do I export the forecast')).toBeNull()
    expect(matchSkill(SOURCES, { process: 'notepad.exe', title: 'notes.txt - Notepad' }, 'how do I save a pixel name')).toBeNull()
    expect(matchSkill([], { process: 'chrome.exe', title: 'Acme Desk' }, 'anything')).toBeNull()
  })

  it('hands the planner the page with its name, cut to a size a small model reads fast', () => {
    const match = matchSkill(SOURCES, { process: 'chrome.exe', title: 'x', url: 'https://desk.acme-example.io' }, 'how')
    const text = skillText(match)
    expect(text.startsWith('Skill page: Acme Desk: how to do anything (guided)')).toBe(true)
    expect(text).toContain('`Create pixel`')
    expect(skillText(null)).toBe('')
    const long = skillText({ source: { id: 'x', kind: 'memory', title: 'Long', text: 'a'.repeat(MAX_SKILL_CHARS + 500) }, score: 9, why: [] })
    expect(long.length).toBeLessThan(MAX_SKILL_CHARS + 60)
    expect(long.endsWith('[cut]')).toBe(true)
    expect(skillText({ source: { id: 't', kind: 'app', title: 'TallyBooks', text: 'About.', url: 'https://app.tallybooks-example.com' }, score: 9, why: [] })).toBe('Learned app: TallyBooks (https://app.tallybooks-example.com)\nAbout.')
  })
})

describe('what the small model is asked', () => {
  const nodes = [node('n1', 'Automations', 'link'), node('n2', 'More options', 'button', undefined, { path: 'Sidebar > Footer' }), node('n3', 'Search', 'textbox', undefined, { value: 'what he typed' }), node('n4', 'Archived', 'button', undefined, { enabled: false }), node('n5', '', 'button'), node('n6', 'Below the fold', 'button', undefined, { offscreen: true })]

  it('lists the elements by id, role, name and place, never their values, never the unnamed or off screen', () => {
    const text = formatNodes(nodes)
    expect(text.split('\n')).toEqual(['n1 | link | Automations', 'n2 | button | More options | Sidebar > Footer', 'n3 | textbox | Search', 'n4 | button | Archived | disabled'])
    expect(text).not.toContain('what he typed')
    expect(formatNodes([])).toContain('no named elements')
  })

  it('gives the planner the question, the window, the skill and the screen; a re-plan also what is done and missing', () => {
    const first = planPrompt({ question: 'how do I invite a member', window: { process: 'chrome.exe', title: 'Acme Desk', url: 'https://desk.acme-example.io/' }, nodes, skill: skillText({ source: SOURCES[0]!, score: 9, why: [] }) })
    expect(first).toContain('Question: how do I invite a member')
    expect(first).toContain('Window: Acme Desk [chrome.exe] at https://desk.acme-example.io/')
    expect(first).toContain('Skill page (the route to follow)')
    expect(first).toContain('More options then Settings menuitem')
    expect(first).not.toContain('Already done')
    const again = planPrompt({ question: 'q', window: { process: 'p', title: 't' }, nodes, skill: '', done: ['Click More options'], missing: 'Settings' })
    expect(again).toContain('Skill page: none')
    expect(again).toContain('Already done by the person, in order: "Click More options"')
    expect(again).toContain('expected "Settings" next')
    // The standing instructions say how a skill page is read, and that nothing is ever done for him.
    expect(PLAN_SYSTEM).toContain('backticks')
    expect(PLAN_SYSTEM).toContain('They do every click themselves')
    expect(PLAN_SYSTEM).toContain('never put a password or key in value')
  })

  it('reads a plan out of whatever the model wraps it in', () => {
    const reply = 'Here you go:\n```json\n{"steps":[{"label":"Click More options","name":"More options","role":"button"},{"label":"Click Settings","name":"Settings","role":"MenuItem"},{"name":"Pixel name","value":"Northwind"},{"label":"nothing named"},{"label":"Odd role","name":"X","role":"wizard","nth":2}],"note":"ok {braces} in a string"}\n```'
    const plan = parsePlan(reply)
    expect(plan.steps).toEqual([
      { label: 'Click More options', name: 'More options', role: 'button' },
      { label: 'Click Settings', name: 'Settings', role: 'menuitem' },
      { label: 'Fill in Pixel name', name: 'Pixel name', value: 'Northwind' },
      { label: 'Odd role', name: 'X', nth: 2 },
    ])
    expect(plan.note).toBe('ok {braces} in a string')
    expect(parsePlan('I cannot help with that.')).toEqual({ steps: [], note: '' })
    expect(parsePlan('{"steps":[],"note":"Open the Automations page first."}')).toEqual({ steps: [], note: 'Open the Automations page first.' })
    expect(parsePlan('{"steps": [ broken')).toEqual({ steps: [], note: '' })
  })

  it('keeps a step value only as a clipboard fill, and sensitive only with a value', () => {
    expect(stepFrom({ name: 'Key', value: 'abc', sensitive: true })).toEqual({ label: 'Fill in Key', name: 'Key', value: 'abc', sensitive: true })
    expect(stepFrom({ name: 'Key', sensitive: true })).toEqual({ label: 'Click Key', name: 'Key' })
    expect(stepFrom({ name: 'Big', value: 'x'.repeat(4_001) })).toEqual({ label: 'Fill in Big', name: 'Big' })
    expect(stepFrom({ label: 'no name' })).toBeNull()
    expect(stepFrom('Save')).toBeNull()
  })

  it('reads which element the model picked, or none', () => {
    expect(parsePick('n2', nodes)?.id).toBe('n2')
    expect(parsePick('`n2`.', nodes)?.id).toBe('n2')
    expect(parsePick('The element is n4 | button', nodes)?.id).toBe('n4')
    expect(parsePick('NONE', nodes)).toBeNull()
    expect(parsePick('none of them', nodes)).toBeNull()
    expect(parsePick('n99', nodes)).toBeNull()
    expect(pickPrompt({ label: 'Open the menu', name: 'Menu', role: 'button' }, { process: 'p', title: 't' }, nodes)).toContain('Looking for: "Menu" (button)')
  })

  it('reads a box from a picture, in pixels or as fractions, kept inside the picture', () => {
    const size = { width: 800, height: 500 }
    expect(parseBox('{"x":100,"y":200,"width":50,"height":20}', size)).toEqual({ x: 100, y: 200, width: 50, height: 20 })
    expect(parseBox('It is here: {"x":0.5,"y":0.5,"width":0.1,"height":0.1}', size)).toEqual({ x: 400, y: 250, width: 80, height: 50 })
    expect(parseBox('{"x":780,"y":490,"width":100,"height":100}', size)).toEqual({ x: 780, y: 490, width: 20, height: 10 })
    expect(parseBox('{"none":true}', size)).toBeNull()
    expect(parseBox('{"x":10,"y":10,"width":1,"height":1}', size)).toBeNull()
    expect(parseBox('no idea', size)).toBeNull()
    expect(locatePrompt({ label: 'Pick the brush', name: 'Brush' }, size)).toContain('800 by 500')
    expect(LOCATE_SYSTEM).toContain('{"none":true}')
  })

  it('reads a picture its size from its header', () => {
    expect(pngSize(fakePng(1920, 1080))).toEqual({ width: 1920, height: 1080 })
    expect(pngSize(Buffer.from('not a picture at all, just words'))).toBeNull()
    expect(pngSize(Buffer.alloc(0))).toBeNull()
  })
})

describe('the quick chat bar: is this line a how-to?', () => {
  it('yes when its first words say so', () => {
    for (const line of ['how do I create a pixel', 'How do I invite someone?', 'show me how to export this', 'Show me where the settings are', 'how to add a member', 'where is the billing page', 'how can I change the theme', 'ok, how do I mute this', 'walk me through inviting a member']) {
      expect(howToQuestion(line), line).toBe(line)
    }
  })

  it('yes with the explicit prefix, which is taken off', () => {
    expect(howToQuestion('/show create a pixel')).toBe('create a pixel')
    expect(howToQuestion('show: export as PDF')).toBe('export as PDF')
    expect(howToQuestion('/show')).toBeNull()
  })

  it('no for an ordinary message: it goes to the chat as before', () => {
    for (const line of ['', 'remind me to call Thabo at 3', 'send the report to Ben', 'what is on my calendar', 'do you know how to cook rice', 'how is the build going', 'how to', 'tell me how the meeting went']) {
      expect(howToQuestion(line), line).toBeNull()
    }
  })
})
