/** IPC channels for the Vault (main/vault). Kept apart from channels.ts so the feature adds one file. */
export const VAULT_CHANNELS = {
  list: 'agent:vault.list',
  save: 'agent:vault.save',
  remove: 'agent:vault.remove',
  reveal: 'agent:vault.reveal',
  copy: 'agent:vault.copy',
  audit: 'agent:vault.audit',
  importAos: 'agent:vault.importAos',
  prefs: 'agent:vault.prefs',
  setPrefs: 'agent:vault.setPrefs',
} as const

export const VAULT_EVENTS = {
  changed: 'agent:evt:vault.changed',
} as const
