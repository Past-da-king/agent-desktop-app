/** A project can use the person's own picture (a website's logo) as its icon, from the dialog or by asking the agent. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { toolNamed, testContext } from './support'
import { isIconImage } from '../src/shared/project-icon'
import { Store } from '../src/main/db'
import { projectTools } from '../src/main/tools/projects'
import { ProjectTile } from '../src/renderer/ui/ProjectTile'

const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let store: Store
let folder: string

beforeEach(() => {
  store = new Store(':memory:')
  folder = mkdtempSync(join(tmpdir(), 'proj-'))
})

afterEach(() => store.close())

function tools(): ReturnType<typeof projectTools> {
  return projectTools({
    store,
    post: async () => undefined,
    state: () => ({ running: false, waiting: [] }),
    agentName: () => 'Nova',
    imageIcon: async (path) => (path.endsWith('logo.png') ? LOGO : null),
  })
}

describe('a project with its own picture', () => {
  it('only takes small square icon images', () => {
    expect(isIconImage(LOGO)).toBe(true)
    expect(isIconImage('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false)
    expect(isIconImage('https://example.com/logo.png')).toBe(false)
    expect(isIconImage(`data:image/png;base64,${'A'.repeat(130_000)}`)).toBe(false)
  })

  it('the agent makes a project with the logo from its folder, shown on the card', async () => {
    let card: unknown = null
    const ctx = testContext({
      ask: async (_q, _o, extra) => {
        card = extra
        return 'Create'
      },
    })
    const out = await toolNamed(tools(), 'project_create').run({ name: 'Guavas site', path: folder, icon_image: join(folder, 'logo.png') }, ctx)
    expect(out).toContain('Made the project Guavas site')
    expect((card as { icon: { image?: string } }).icon.image).toBe(LOGO)
    const [made] = await store.list('project')
    expect(made?.icon.image).toBe(LOGO)
  })

  it('says plainly when the file is not a picture, and can go back to the glyph', async () => {
    const create = toolNamed(tools(), 'project_create')
    expect(await create.run({ name: 'X', path: folder, icon_image: join(folder, 'notes.txt') }, testContext({ ask: async () => 'Create' }))).toContain('is not a picture')
    await create.run({ name: 'Y', path: folder, icon_image: join(folder, 'logo.png') }, testContext({ ask: async () => 'Create' }))
    const update = toolNamed(tools(), 'project_update')
    expect(await update.run({ project: 'Y', icon_image: 'none' }, testContext())).toContain('icon back to its glyph')
    const row = (await store.list('project')).find((p) => p.name === 'Y')
    expect(row?.icon.image).toBeUndefined()
    expect(await update.run({ project: 'Y', icon_image: join(folder, 'logo.png') }, testContext())).toContain('its own picture')
  })

  it('draws the picture on the tile instead of the glyph', () => {
    const html = renderToStaticMarkup(createElement(ProjectTile, { icon: { glyph: 'globe', color: 'ocean', image: LOGO }, size: 44 }))
    expect(html).toContain('<img class="pj-img"')
    expect(html).not.toContain('<svg')
    const plain = renderToStaticMarkup(createElement(ProjectTile, { icon: { glyph: 'globe', color: 'ocean', image: 'javascript:alert(1)' } }))
    expect(plain).not.toContain('<img')
  })
})
