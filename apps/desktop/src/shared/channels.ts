/**
 * IPC channel names shared by the main process, the preload script and the contract test.
 * Keeping them in one place stops a handler and a caller drifting apart.
 */

export const CHANNELS = {
  settings: {
    get: 'agent:settings.get',
    save: 'agent:settings.save',
    providers: 'agent:settings.providers',
    setApiKey: 'agent:settings.setApiKey',
    checkKey: 'agent:settings.checkKey',
    reset: 'agent:settings.reset',
  },
  account: {
    signIn: 'agent:account.signIn',
    signOut: 'agent:account.signOut',
    firstSync: 'agent:account.firstSync',
    syncNow: 'agent:account.syncNow',
    status: 'agent:account.status',
  },
  data: {
    list: 'agent:data.list',
    upsert: 'agent:data.upsert',
    remove: 'agent:data.remove',
  },
  chat: {
    send: 'agent:chat.send',
    stop: 'agent:chat.stop',
    state: 'agent:chat.state',
    answer: 'agent:chat.answer',
    decide: 'agent:chat.decide',
  },
  routines: {
    runNow: 'agent:routines.runNow',
  },
  helpers: {
    stop: 'agent:helpers.stop',
    stopAll: 'agent:helpers.stopAll',
  },
  window: {
    minimize: 'agent:window.minimize',
    toggleMaximize: 'agent:window.toggleMaximize',
    close: 'agent:window.close',
    isMaximized: 'agent:window.isMaximized',
  },
  files: {
    pick: 'agent:files.pick',
    pickFolder: 'agent:files.pickFolder',
  },
  shell: {
    openExternal: 'agent:shell.openExternal',
    reveal: 'agent:shell.reveal',
  },
} as const

export const EVENTS = {
  settings: 'agent:evt:settings.changed',
  accountStatus: 'agent:evt:account.status',
  accountProgress: 'agent:evt:account.progress',
  data: 'agent:evt:data.changed',
  chat: 'agent:evt:chat.event',
  maximize: 'agent:evt:window.maximized',
  quickAsk: 'agent:evt:window.quickAsk',
} as const
