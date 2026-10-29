/**
 * 29 Oct 2026, on his phone: tapping a project in the '@' list did not pick it. The row picks the moment the finger or
 * mouse goes down (pointerdown) and keeps the message box focused, so a list that moves or closes on release cannot
 * swallow the tap.
 */
import { isValidElement, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { MentionProject } from '../src/shared/mentions'

vi.mock('../src/renderer/bridge', () => ({ agent: { platform: 'web' }, chat: {} }))

const { MentionPicker } = await import('../src/renderer/views/MentionPicker')

const p = (id: string, name: string): MentionProject => ({ id, name, aliases: [], glyph: 'bolt', color: 'teal', image: '', railAt: 0 })

function rows(element: ReactElement): ReactElement[] {
  const kids = (element.props as { children: unknown[] }).children
  return (kids.flat() as unknown[]).filter((kid): kid is ReactElement => isValidElement(kid) && (kid.props as { role?: string }).role === 'option')
}

describe("the '@' list", () => {
  it('picks on pointer down and keeps the focus in the message box', () => {
    const picked: string[] = []
    const list = MentionPicker({ items: [p('a', 'Acme'), p('b', 'Nova Print')], active: 0, onPick: (project) => picked.push(project.name), onHover: () => undefined })
    expect(list).not.toBeNull()
    const [first, second] = rows(list as ReactElement)
    let prevented = 0
    const event = { preventDefault: () => void (prevented += 1) }
    const props = second?.props as { onPointerDown?: (e: unknown) => void; onMouseDown?: (e: unknown) => void }
    expect(typeof props.onPointerDown).toBe('function')
    props.onPointerDown?.(event)
    expect(picked).toEqual(['Nova Print'])
    props.onMouseDown?.(event)
    expect(prevented).toBe(2)
    expect((first?.props as { 'aria-selected'?: boolean })['aria-selected']).toBe(true)
  })
})
