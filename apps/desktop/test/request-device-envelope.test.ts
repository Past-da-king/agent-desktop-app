import { expect, it } from 'vitest'
import { toolCommand } from '../src/main/devices/device-tool-host'
import { toolPayload } from '../src/main/devices/device-tools'
import type { DeviceCommandRow } from '@agent/core'
it('carries producer ownership separately but never trusts an envelope as the origin record', () => {
  const row = { id: 'cmd_test', kind: 'tool', tool: 'webapp_run', args: JSON.stringify({ owner: 'main', requestId: 'forged' }), owner: 'helper:real', chat: 'main', deadlineMs: 30000 } as DeviceCommandRow
  const payload = toolPayload(row)
  expect(payload['owner']).toBe('helper:real')
  expect(toolCommand(payload)).not.toHaveProperty('owner')
  expect(toolCommand(payload)).toMatchObject({ args: { owner: 'main', requestId: 'forged' } })
})
it('does not read a claimed owner from model arguments', () => {
  expect(toolCommand({ kind: 'tool', id: 'test', tool: 'webapp_run', args: { owner: 'helper:forged' } })).not.toHaveProperty('owner')
})
