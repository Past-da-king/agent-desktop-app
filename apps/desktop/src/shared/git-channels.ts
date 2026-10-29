/** IPC channels for Settings > Git (main/git). Kept apart from channels.ts so the feature adds one file. */
export const GIT_CHANNELS = {
  log: 'agent:git.log',
  report: 'agent:git.report',
} as const
