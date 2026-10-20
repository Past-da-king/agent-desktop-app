/**
 * Which tab the agent works in when the browser is shared by several profiles, each in its own
 * partition. Pure, so it is tested without Electron.
 */
export interface PartitionedTab {
  id: string
  partition: string
}

/**
 * The active tab when it is in `partition`; otherwise that partition's most recent tab; otherwise
 * null, so the next open makes a new tab there. A tab of another profile is never handed out.
 */
export function pickTab<T extends PartitionedTab>(tabs: readonly T[], activeId: string | null, partition: string): T | null {
  const active = tabs.find((tab) => tab.id === activeId)
  if (active !== undefined && active.partition === partition) return active
  for (let i = tabs.length - 1; i >= 0; i -= 1) {
    const tab = tabs[i]
    if (tab !== undefined && tab.partition === partition) return tab
  }
  return null
}
