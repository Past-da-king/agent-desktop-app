import { describe, expect, it } from 'vitest'
import type { DeviceRow, JobRow } from '@agent/core'

import { chatPlaces } from '../src/renderer/lib/chat-place'
import { folderLine } from '../src/main/runtime/prompt'
import { ConnectionLog } from '../src/main/devices/conn-log'
import { choosePlacement } from '../src/main/runtime/offload'

const device = (id: string, name: string): DeviceRow => ({ id, name }) as DeviceRow
const claim = (chat: string, to: string, status = 'on'): JobRow => ({ id: `chat-${chat}`, kind: 'claim', op: 'chat', device: to, status }) as JobRow

describe('where a chat runs', () => {
  it('names the device of every placed chat', () => {
    const places = chatPlaces([claim('pc1', 'srv'), claim('pc2', 'gone', 'off'), { id: 'x', kind: 'msg', op: 'post', device: 'srv' } as JobRow], [device('srv', 'impetix')])
    expect([...places]).toEqual([['pc1', 'impetix']])
  })
  it('says a project folder that is not on this computer is elsewhere', () => {
    expect(folderLine('C:\\proj', () => false)).toContain('on another computer')
    expect(folderLine('/home/x/proj', () => true)).toContain('Work there by default')
  })
  it('keeps a named device even when the project has a folder on the PC', () => {
    const server = { id: 'srv', name: 'impetix', kind: 'server', up: true, capacity: { accounts: ['a'], cap: 100, active: 0 } }
    const result = choosePlacement({ text: 'x', account: 'a', device: 'impetix', localFolder: true }, [server] as never, 'desktop', 'best')
    expect(result.device).toBe('srv')
  })
  it('says a hung-up handshake once a minute however many addresses it comes from', () => {
    const lines: string[] = []
    const log = new ConnectionLog((m) => lines.push(m), () => 0)
    for (let i = 0; i < 15; i++) log.note('tls:ECONNRESET', 'Devices TLS handshake failed', { from: `10.0.0.${i}` })
    expect(lines).toHaveLength(1)
  })
})
