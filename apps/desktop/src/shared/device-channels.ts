/**
 * The calls only a linked phone makes to keep its data use small (RPC names data.since, data.page, device.prefs).
 * They are not part of the window's AgentApi: the window never asks. Registered in main/ipc.ts, allowed in
 * shared/rpc-methods.ts.
 */
export const DEVICE_CHANNELS = {
  prefs: 'agent:device.prefs',
  since: 'agent:data.since',
  page: 'agent:data.page',
  connectApp: 'agent:apps.connectLink',
} as const

/** The same, by dotted RPC name. */
export const DEVICE_RPC_CHANNELS: Readonly<Record<string, string>> = {
  'device.prefs': DEVICE_CHANNELS.prefs,
  'data.since': DEVICE_CHANNELS.since,
  'data.page': DEVICE_CHANNELS.page,
  'apps.connectLink': DEVICE_CHANNELS.connectApp,
}
