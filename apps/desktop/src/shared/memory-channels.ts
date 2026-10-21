/**
 * IPC channels for long-term memory (New Chat filing, past chats, the import and the end-of-day pass). Kept apart
 * from channels.ts so this feature adds one file instead of reflowing the shared one.
 */
export const MEMORY_CHANNELS = {
  newChat: 'agent:memory.newChat',
  retrySave: 'agent:memory.retrySave',
  pickImport: 'agent:memory.pickImport',
  previewImport: 'agent:memory.previewImport',
  runImport: 'agent:memory.runImport',
  searchChats: 'agent:memory.searchChats',
  runDaily: 'agent:memory.runDaily',
  upkeep: 'agent:memory.upkeep',
  undoChange: 'agent:memory.undoChange',
  previewTidy: 'agent:memory.previewTidy',
  startTidy: 'agent:memory.startTidy',
  stopTidy: 'agent:memory.stopTidy',
  tidyState: 'agent:memory.tidyState',
  undoTidy: 'agent:memory.undoTidy',
} as const

export const MEMORY_EVENTS = {
  upkeep: 'agent:evt:memory.upkeep',
  tidy: 'agent:evt:memory.tidy',
} as const
