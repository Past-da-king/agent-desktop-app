/** IPC channels for a memory page's kept versions (main/memory/history-ipc.ts). Apart from memory-channels.ts so each feature adds a file. */
export const MEMORY_HISTORY_CHANNELS = {
  history: 'agent:memory.history',
  restoreVersion: 'agent:memory.restoreVersion',
} as const
