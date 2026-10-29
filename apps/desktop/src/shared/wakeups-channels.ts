/** IPC channels for wake-ups (main/wakeups). Kept apart from channels.ts so the feature adds one file. */
export const WAKEUP_CHANNELS = {
  test: 'agent:wakeups.test',
  ack: 'agent:wakeups.ack',
  snooze: 'agent:wakeups.snooze',
  selfId: 'agent:wakeups.selfId',
  devices: 'agent:wakeups.devices',
} as const

/** RPC methods and the event a linked device (the phone's wake channel) uses. */
export const WAKEUP_RPC = {
  list: 'wakeups.list',
  ack: 'wakeups.ack',
  snooze: 'wakeups.snooze',
  seen: 'wakeups.seen',
  status: 'wakeups.status',
  test: 'wakeups.test',
  changed: 'wakeups.changed',
} as const
