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
    listModels: 'agent:settings.listModels',
    checkCli: 'agent:settings.checkCli',
    cliLogin: 'agent:settings.cliLogin',
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
    tap: 'agent:chat.tap',
  },
  routines: {
    runNow: 'agent:routines.runNow',
  },
  browser: {
    setBounds: 'agent:browser.setBounds',
    state: 'agent:browser.state',
    back: 'agent:browser.back',
    reload: 'agent:browser.reload',
    selectTab: 'agent:browser.selectTab',
    closeTab: 'agent:browser.closeTab',
    takeOver: 'agent:browser.takeOver',
    giveBack: 'agent:browser.giveBack',
    openInSystem: 'agent:browser.openInSystem',
    setView: 'agent:browser.setView',
    setExpanded: 'agent:browser.setExpanded',
  },
  helpers: {
    stop: 'agent:helpers.stop',
    stopAll: 'agent:helpers.stopAll',
  },
  apps: {
    status: 'agent:apps.status',
    setKey: 'agent:apps.setKey',
    catalog: 'agent:apps.catalog',
    connect: 'agent:apps.connect',
    disconnect: 'agent:apps.disconnect',
    setRules: 'agent:apps.setRules',
    learned: 'agent:apps.learned',
    removeLearned: 'agent:apps.removeLearned',
    setTrusted: 'agent:apps.setTrusted',
  },
  profiles: {
    list: 'agent:profiles.list',
    create: 'agent:profiles.create',
    update: 'agent:profiles.update',
    remove: 'agent:profiles.remove',
    setMember: 'agent:profiles.setMember',
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
    register: 'agent:files.register',
    thumbnail: 'agent:files.thumbnail',
  },
  system: {
    info: 'agent:system.info',
  },
  environment: {
    scan: 'agent:environment.scan',
  },
  shell: {
    openExternal: 'agent:shell.openExternal',
    reveal: 'agent:shell.reveal',
  },
  voice: {
    setKey: 'agent:voice.setKey',
    check: 'agent:voice.check',
    transcribe: 'agent:voice.transcribe',
    speak: 'agent:voice.speak',
    noteAudio: 'agent:voice.noteAudio',
    callStart: 'agent:voice.callStart',
    callAudio: 'agent:voice.callAudio',
    callMute: 'agent:voice.callMute',
    callEnd: 'agent:voice.callEnd',
  },
  app: {
    info: 'agent:app.info',
    openLogsFolder: 'agent:app.openLogsFolder',
    openLicences: 'agent:app.openLicences',
  },
} as const

export const EVENTS = {
  settings: 'agent:evt:settings.changed',
  accountStatus: 'agent:evt:account.status',
  accountProgress: 'agent:evt:account.progress',
  data: 'agent:evt:data.changed',
  chat: 'agent:evt:chat.event',
  browser: 'agent:evt:browser.state',
  maximize: 'agent:evt:window.maximized',
  quickAsk: 'agent:evt:window.quickAsk',
  route: 'agent:evt:window.route',
  hotkey: 'agent:evt:window.hotkey',
  apps: 'agent:evt:apps.changed',
  voiceCall: 'agent:evt:voice.call',
  profiles: 'agent:evt:profiles.changed',
} as const
