/**
 * The tools the agent has while it speaks on a call. It is the same agent: real work starts in its own main chat.
 *
 *   start_work      puts a brief in the main chat (labelled as from the call) and says it started.
 *   show_on_screen  puts a list, an image or a small card next to the orb, and in the chat afterwards.
 *   memory_search, memory_get, task_list, now   quick lookups it may answer from itself.
 */
import { enumOf, schema, str, type CallVisual, type JsonObject, type Tool } from '@agent/core'

import type { DataStore } from '../runtime/data'
import { coreTools } from './core'
import { memoryTools } from './memory'
import { taskTools } from './tasks'

export interface VoiceToolDeps {
  store: DataStore
  /** Starts real work in the main chat. Resolves once the message is in, not when the work is done. */
  handToAgent(brief: string): Promise<{ queued: boolean }>
  /** Show something during the call. */
  show(visual: Omit<CallVisual, 'id' | 'at'>): Promise<void>
  now?: () => Date
}

const LOOKUPS = new Set(['memory_search', 'memory_get', 'task_list', 'now'])
const MAX_ITEMS = 8
const MAX_TEXT = 400

export function voiceTools(deps: VoiceToolDeps): Tool[] {
  const lookups = [
    ...coreTools({ store: deps.store, ...(deps.now === undefined ? {} : { now: deps.now }) }),
    ...memoryTools(deps.store),
    ...taskTools(deps.store),
  ].filter((tool) => LOOKUPS.has(tool.spec.name))
  return [handToAgent(deps), showOnScreen(deps), ...lookups]
}

function handToAgent(deps: VoiceToolDeps): Tool {
  return {
    spec: {
      name: 'start_work',
      description:
        'Start real work yourself (research, writing, files, the browser, anything that takes more than a quick answer). ' +
        'It begins at once in your main chat, where you have every tool. Write a clear, complete brief with every detail the person gave; ' +
        'tell the person in a few words that you are on it, then keep talking.',
      schema: schema(['task'], {
        task: str('The full brief, with names, dates and preferences the person mentioned'),
      }),
    },
    run: async (input) => {
      const task = clip(input['task'], 4_000)
      if (task === '') return 'A brief is needed: say what you are going to do.'
      const { queued } = await deps.handToAgent(task)
      return queued
        ? 'Added to what you are already doing. Tell the person it is on your list.'
        : 'Started in your main chat. Tell the person briefly that you are on it, then carry on.'
    },
  }
}

function showOnScreen(deps: VoiceToolDeps): Tool {
  return {
    spec: {
      name: 'show_on_screen',
      description:
        'Put something on screen next to you while you talk about it: a short list (steps, options, numbers), ' +
        'an image from an https address, or a small card with a fact. Keep it short; say the gist out loud too. ' +
        'It stays in the chat after the call.',
      schema: schema(['kind', 'title'], {
        kind: enumOf('What to show', 'list', 'image', 'card'),
        title: str('A short title, a few words'),
        items: { type: 'array', items: { type: 'string' }, description: 'For a list: up to 8 short points' },
        image_url: str('For an image: an https address of the picture'),
        body: str('For a card: one or two short sentences'),
        footnote: str('Optional small print under a card, such as a source or a date'),
      }),
    },
    run: async (input) => {
      const visual = visualFrom(input)
      if (typeof visual === 'string') return visual
      await deps.show(visual)
      return 'It is on screen now. Talk about it; do not read it out word for word.'
    },
  }
}

/** Validates what the model asked to show. A string back is the problem, in words the model can act on. */
export function visualFrom(input: JsonObject): Omit<CallVisual, 'id' | 'at'> | string {
  const kind = input['kind']
  const title = clip(input['title'], 120)
  if (kind !== 'list' && kind !== 'image' && kind !== 'card') return 'kind must be list, image or card.'
  if (title === '') return 'A title is needed.'
  if (kind === 'list') {
    const raw = Array.isArray(input['items']) ? input['items'] : []
    const items = raw.map((item) => clip(item, 160)).filter((item) => item !== '').slice(0, MAX_ITEMS)
    if (items.length === 0) return 'A list needs at least one item.'
    return { kind, title, items }
  }
  if (kind === 'image') {
    const url = clip(input['image_url'], 2_000)
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return 'image_url must be a full https address.'
    }
    if (parsed.protocol !== 'https:') return 'image_url must be an https address.'
    return { kind, title, imageUrl: parsed.toString() }
  }
  const body = clip(input['body'], MAX_TEXT)
  if (body === '') return 'A card needs a body.'
  const footnote = clip(input['footnote'], 160)
  return footnote === '' ? { kind, title, body } : { kind, title, body, footnote }
}

/** The same visual as plain markdown, so the chat (and the phone) can show it without the card. */
export function visualMarkdown(visual: Pick<CallVisual, 'kind' | 'title' | 'items' | 'imageUrl' | 'body' | 'footnote'>): string {
  const lines = [`**${visual.title}**`]
  if (visual.kind === 'list') lines.push('', ...(visual.items ?? []).map((item) => `- ${item}`))
  if (visual.kind === 'image' && visual.imageUrl !== undefined) lines.push('', `![${visual.title}](${visual.imageUrl})`)
  if (visual.kind === 'card') {
    lines.push('', visual.body ?? '')
    if (visual.footnote !== undefined && visual.footnote !== '') lines.push('', `_${visual.footnote}_`)
  }
  return lines.join('\n')
}

function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}
