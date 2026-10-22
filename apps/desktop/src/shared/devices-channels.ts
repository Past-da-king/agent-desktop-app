/** IPC channels for Settings > Devices (main/devices/service.ts). Apart from channels.ts so this feature adds a file. */
export const DEVICES_CHANNELS = {
  status: 'agent:devices.status',
  setEnabled: 'agent:devices.setEnabled',
  setExtraUrls: 'agent:devices.setExtraUrls',
  offer: 'agent:devices.offer',
  cancelOffer: 'agent:devices.cancelOffer',
  list: 'agent:devices.list',
  setRoles: 'agent:devices.setRoles',
  move: 'agent:devices.move',
  revoke: 'agent:devices.revoke',
  setShareGroup: 'agent:devices.setShareGroup',
  allowFirewall: 'agent:devices.allowFirewall',
} as const

export const DEVICES_EVENTS = {
  changed: 'agent:evt:devices.changed',
} as const
