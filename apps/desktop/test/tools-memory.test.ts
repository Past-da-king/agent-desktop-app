import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { memoryTools } from '../src/main/tools/memory'
import { testContext, toolNamed } from './support'

let store: Store

beforeEach(() => {
  store = new Store(':memory:')
})

afterEach(() => {
  store.close()
})

describe('memory tools', () => {
  it('saves a page with every field the store keeps', async () => {
    const save = toolNamed(memoryTools(store), 'memory_save')
    const answer = await save.run(
      {
        title: 'Lerato',
        body: "Sam's sister. Lives in [[Durban]].",
        kind: 'person',
        topics: 'family, durban',
        pinned: true,
      },
      testContext(),
    )

    expect(answer).toContain("Saved page #")
    const [page] = await store.list('memory')
    expect(page).toMatchObject({
      title: 'Lerato',
      body: "Sam's sister. Lives in [[Durban]].",
      kind: 'person',
      topics: 'family, durban',
      pinned: true,
      source: 'agent',
    })
  })

  it('updates the page instead of adding a second one with the same title', async () => {
    const save = toolNamed(memoryTools(store), 'memory_save')
    await save.run({ title: 'Lerato', body: 'Old note.', topics: 'family' }, testContext())
    const answer = await save.run(
      { title: 'lerato', body: 'New note.', topics: 'family, durban' },
      testContext(),
    )

    expect(answer).toContain('Updated page')
    const pages = await store.list('memory')
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ title: 'lerato', body: 'New note.', topics: 'family, durban' })
  })

  it('falls back to a fact when the kind is unknown', async () => {
    const save = toolNamed(memoryTools(store), 'memory_save')
    await save.run({ title: 'Parking', body: 'Level 2.', kind: 'nonsense', topics: 'home' }, testContext())
    const [page] = await store.list('memory')
    expect(page?.kind).toBe('fact')
  })

  it('searches by meaning of the words, and says so when nothing matches', async () => {
    const save = toolNamed(memoryTools(store), 'memory_save')
    const search = toolNamed(memoryTools(store), 'memory_search')
    await save.run({ title: 'Lerato', body: 'Lives in Durban.', topics: 'family' }, testContext())
    await save.run({ title: 'Bakery', body: 'On the corner.', topics: 'food' }, testContext())

    const found = await search.run({ query: 'Where does Lerato stay?' }, testContext())
    expect(found).toContain('Lives in Durban.')
    expect(found).not.toContain('On the corner.')

    expect(await search.run({ query: 'quantum physics' }, testContext())).toBe('No memories match.')
  })

  it('reads a page by id with the pages that link to it', async () => {
    const save = toolNamed(memoryTools(store), 'memory_save')
    const get = toolNamed(memoryTools(store), 'memory_get')
    const place = await save.run({ title: 'Durban', body: 'A city by the sea.', topics: 'places' }, testContext())
    const id = place.split('#')[1]?.split(' ')[0] ?? ''
    await save.run({ title: 'Lerato', body: 'Lives in [[Durban]].', topics: 'family' }, testContext())

    const page = await get.run({ id }, testContext())
    expect(page).toContain('A city by the sea.')
    expect(page).toContain('Linked from: Lerato')
  })

  it('also finds a page by its exact title, and explains a miss', async () => {
    const save = toolNamed(memoryTools(store), 'memory_save')
    const get = toolNamed(memoryTools(store), 'memory_get')
    await save.run({ title: 'Durban', body: 'A city by the sea.', topics: 'places' }, testContext())

    expect(await get.run({ id: 'durban' }, testContext())).toContain('A city by the sea.')
    expect(await get.run({ id: 'nowhere' }, testContext())).toBe("No memory page called 'nowhere'.")
  })

  it('corrects a page and can delete it', async () => {
    const save = toolNamed(memoryTools(store), 'memory_save')
    const update = toolNamed(memoryTools(store), 'memory_update')
    const saved = await save.run({ title: 'Lerato', body: 'Lives in Durban.', topics: 'family' }, testContext())
    const id = saved.split('#')[1]?.split(' ')[0] ?? ''

    expect(await update.run({ id, body: 'Lives in Cape Town.' }, testContext())).toContain('Updated')
    const [page] = await store.list('memory')
    expect(page?.body).toBe('Lives in Cape Town.')

    expect(await update.run({ id, delete: true }, testContext())).toContain('Deleted')
    expect(await store.list('memory')).toEqual([])
  })

  it('explains a miss on update instead of throwing', async () => {
    const update = toolNamed(memoryTools(store), 'memory_update')
    expect(await update.run({ id: 'nope' }, testContext())).toBe('No memory #nope.')
  })
})
