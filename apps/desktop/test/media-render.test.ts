// The renderer half of shown media: the card the agent posts must actually play, in the app, and only ever from the
// opaque address the main process made (agent-media://f/<32 hex>) or a web one. These guard the contract between
// main/tools/media.ts and the renderer, so a later edit to a card, the markdown or the policy cannot quietly break it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { LIBRARY, parse, render, type UiNode } from '../src/renderer/openui/lang'
import { MediaBlock, mediaSrcOk } from '../src/renderer/ui/MediaBlock'

const TOKEN = 'agent-media://f/0123456789abcdef0123456789abcdef'

function children(n: UiNode): UiNode[] {
  const kids = n.props['children']
  return Array.isArray(kids) ? kids.filter((k): k is UiNode => typeof k === 'object' && k !== null && typeof (k as UiNode).type === 'string') : []
}

function find(n: UiNode, type: string): UiNode | null {
  if (n.type === type) return n
  for (const kid of children(n)) {
    const hit = find(kid, type)
    if (hit !== null) return hit
  }
  return null
}

describe('a video the agent shows, in a generated card', () => {
  it('is a library component of src and caption', () => {
    expect(LIBRARY['Video']).toEqual(['src', 'caption'])
  })

  it('parses a real program to a Video node that carries the token address and the caption', () => {
    const source = [
      'root = Stack([c1])',
      `c1 = Card([CardHeader("Rendered clip", "3 Nov"), Video("${TOKEN}", "Ten seconds, no sound")])`,
    ].join('\n')
    const tree = render(parse(source))
    expect(tree.errors).toEqual([])
    const root = tree.root
    expect(root).not.toBeNull()
    if (root === null) return
    const card = children(root)[0]
    expect(card?.type).toBe('Card')
    const video = card === undefined ? null : find(card, 'Video')
    expect(video).not.toBeNull()
    expect(video?.props).toEqual({ src: TOKEN, caption: 'Ten seconds, no sound' })
  })

  it('keeps a video with no caption to just its address', () => {
    const source = `root = Card([Video("${TOKEN}")])`
    const root = render(parse(source)).root
    expect(root).not.toBeNull()
    if (root === null) return
    const video = find(root, 'Video')
    expect(video?.props).toEqual({ src: TOKEN })
  })
})

describe('the page policy', () => {
  const html = readFileSync(join(__dirname, '../src/renderer/index.html'), 'utf8')
  const policy = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? ''
  const directive = (name: string): string[] =>
    (policy.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === name) ?? []).slice(1)

  it('lets a picture load from the token address', () => {
    expect(directive('img-src')).toContain('agent-media:')
  })

  it('lets a video and a sound stream from the token address', () => {
    expect(directive('media-src')).toContain('agent-media:')
  })
})

describe('the chat row', () => {
  const chat = readFileSync(join(__dirname, '../src/renderer/views/Chat.tsx'), 'utf8')

  it('draws a media row through MediaBlock', () => {
    expect(chat).toContain("case 'media':")
    expect(chat).toContain("from '../ui/MediaBlock'")
    expect(chat).toContain('<MediaBlock')
  })
})

describe('what may be drawn', () => {
  it('takes the token address the main process made, and a web address', () => {
    expect(mediaSrcOk(TOKEN)).toBe(true)
    expect(mediaSrcOk(`  ${TOKEN}  `)).toBe(true)
    expect(mediaSrcOk('https://example.com/clip.mp4')).toBe(true)
    expect(mediaSrcOk('https://example.com/a.png?x=1')).toBe(true)
  })

  it('refuses every other address, so a card can never point somewhere else', () => {
    for (const bad of [
      '',
      'C:\\clips\\clip.mp4',
      'file:///C:/clips/clip.mp4',
      '/home/you/clips/clip.mp4',
      'http://example.com/clip.mp4',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'blob:http://localhost/1234',
      'agent-media://f/0123456789abcdef',
      'agent-media://f/0123456789ABCDEF0123456789ABCDEF',
      'agent-media://f/../../windows/win.ini',
      'agent-media://x/0123456789abcdef0123456789abcdef',
      'https://example.com/clip.mp4" onerror="alert(1)',
    ]) {
      expect(mediaSrcOk(bad), bad).toBe(false)
    }
  })
})

describe('the card itself', () => {
  const draw = (props: Parameters<typeof MediaBlock>[0]): string => renderToStaticMarkup(createElement(MediaBlock, props))

  it('draws a real player for a video, with the browser controls and one line under it', () => {
    const html = draw({ kind: 'video', src: TOKEN, caption: 'Ten seconds, no sound', name: 'clip.mp4' })
    expect(html).toContain('<video')
    expect(html).toContain('controls')
    expect(html).toContain(`src="${TOKEN}"`)
    expect(html).toContain('mb-video')
    expect(html).toContain('Ten seconds, no sound')
  })

  it('draws a player and the file name for a sound', () => {
    const html = draw({ kind: 'audio', src: TOKEN, name: 'note.mp3' })
    expect(html).toContain('<audio')
    expect(html).toContain('controls')
    expect(html).toContain('note.mp3')
  })

  it('draws a picture as a button that enlarges it, closed until it is clicked', () => {
    const html = draw({ kind: 'image', src: TOKEN, name: 'site.png' })
    expect(html).toContain('<button')
    expect(html).toContain('mb-pic')
    expect(html).toContain('<img')
    expect(html).toContain('alt="site.png"')
    expect(html).not.toContain('mb-light')
  })

  it('refuses an address that is not a token or https, and draws no player at all', () => {
    const html = draw({ kind: 'video', src: 'C:\\clips\\clip.mp4', name: 'clip.mp4' })
    expect(html).toContain('This file cannot be shown here')
    expect(html).not.toContain('<video')
    expect(html).not.toContain('clip.mp4')
  })
})
