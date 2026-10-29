/** IPC channels for mini-apps (main/miniapps/ipc.ts). Kept apart from channels.ts so the feature adds one file. */
export const MINIAPP_CHANNELS = {
  session: 'agent:miniapps.session',
  send: 'agent:miniapps.send',
  close: 'agent:miniapps.close',
  pin: 'agent:miniapps.pin',
  unpin: 'agent:miniapps.unpin',
  order: 'agent:miniapps.order',
  remove: 'agent:miniapps.remove',
  undo: 'agent:miniapps.undo',
  allow: 'agent:miniapps.allow',
  check: 'agent:miniapps.check',
  askChange: 'agent:miniapps.askChange',
  info: 'agent:miniapps.info',
} as const

export const MINIAPP_EVENTS = {
  /** A message for an open frame: [sessionId, message]. */
  push: 'agent:miniapps.push',
  /** An agent asked to show an app: [appId]. */
  open: 'agent:miniapps.open',
} as const

/** RPC a linked device (the phone) uses to run an app it shows: same messages, same checks. */
export const MINIAPP_RPC = {
  session: 'miniapps.session',
  call: 'miniapps.call',
  close: 'miniapps.close',
  push: 'miniapps.push',
  pin: 'miniapps.pin',
  unpin: 'miniapps.unpin',
} as const
