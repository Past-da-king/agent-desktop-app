/** IPC channels for Settings > Devices (main/devices/service.ts). Apart from channels.ts so this feature adds a file. */
export const DEVICES_CHANNELS = {
  status: 'agent:devices.status',
  setEnabled: 'agent:devices.setEnabled',
  setExtraUrls: 'agent:devices.setExtraUrls',
  setNetwork: 'agent:devices.setNetwork',
  offer: 'agent:devices.offer',
  cancelOffer: 'agent:devices.cancelOffer',
  list: 'agent:devices.list',
  setRoles: 'agent:devices.setRoles',
  move: 'agent:devices.move',
  revoke: 'agent:devices.revoke',
  /** Deletes a taken-out device's row for good. */
  forget: 'agent:devices.forget',
  /** Join the devices of another node from the pairing link it made (headless JOIN_CHANNEL is a different thing). */
  join: 'agent:devices.joinLink',
  setShareGroup: 'agent:devices.setShareGroup',
  allowFirewall: 'agent:devices.allowFirewall',
} as const

export const DEVICES_EVENTS = {
  changed: 'agent:evt:devices.changed',
} as const
