import { describe, expect, it } from 'vitest'
import { AnswerOrder } from '../src/main/devices/answer-order'

describe('recovered preferred brain', () => {
  it('hands idle screens back after two healthy checks, once per recovery, without touching running turns', async () => {
    let up = false
    let busy = false
    const moved: string[] = []
    const order = new AnswerOrder({ selfId: () => 'server', brains: () => [{ id: 'pc', name: 'PC' }, { id: 'server', name: 'Server' }], health: async () => up, busy: () => busy, screens: () => ['phone'], handback: (id) => moved.push(id) })
    await order.tick()
    expect(order.line()).toContain('PC is not reachable')
    up = true; busy = true
    await order.tick(); await order.tick()
    expect(moved).toEqual([])
    busy = false
    await order.tick()
    expect(moved).toEqual(['phone'])
    expect(order.line()).toContain('PC is ready: first in order')
    await order.tick(); await order.tick()
    expect(moved).toEqual(['phone'])
    up = false; await order.tick(); up = true; await order.tick(); await order.tick()
    expect(moved).toEqual(['phone', 'phone'])
  })
  it('does not yield on a single probe or retain an old preferred brain after order changes', async () => {
    let rows = [{ id: 'pc', name: 'PC' }, { id: 'server', name: 'Server' }]
    const moved: string[] = []
    const order = new AnswerOrder({ selfId: () => 'server', brains: () => rows, health: async () => true, busy: () => false, screens: () => ['phone'], handback: id => moved.push(id) })
    await order.tick(); expect(moved).toEqual([])
    rows = [...rows].reverse(); await order.tick()
    expect(order.line()).toBe('Server is answering: first in order.')
    expect(moved).toEqual([])
  })
})
