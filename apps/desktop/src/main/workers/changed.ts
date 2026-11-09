/**
 * "Something about the workers changed", told to the windows once per burst and with WHICH workers, so a card that
 * shows one worker's events or log reads again only when its own worker changed. A change with no id (an event
 * routed, a status set on several events) means "any of them": the payload is then null and everyone reads again.
 */
export type WorkersChanged = { workers: string[] } | null

export function createWorkersChanged(send: (payload: WorkersChanged) => void, waitMs = 300): (workerId?: string) => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let ids = new Set<string>()
  let all = false
  return (workerId) => {
    if (workerId === undefined || workerId === '') all = true
    else ids.add(workerId)
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      const payload: WorkersChanged = all ? null : { workers: [...ids] }
      ids = new Set()
      all = false
      send(payload)
    }, waitMs)
  }
}
