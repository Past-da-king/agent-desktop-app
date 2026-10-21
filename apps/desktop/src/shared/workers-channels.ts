/** IPC channels for background workers (main/workers). Kept apart from channels.ts so the feature adds one file. */
export const WORKER_CHANNELS = {
  list: 'agent:workers.list',
  events: 'agent:workers.events',
  logs: 'agent:workers.logs',
  start: 'agent:workers.start',
  stop: 'agent:workers.stop',
  restart: 'agent:workers.restart',
  remove: 'agent:workers.remove',
  setSecret: 'agent:workers.setSecret',
  openFolder: 'agent:workers.openFolder',
} as const

export const WORKER_EVENTS = {
  changed: 'agent:evt:workers.changed',
} as const
