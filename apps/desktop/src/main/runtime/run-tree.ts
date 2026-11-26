import type { ChildProcess } from 'node:child_process'

/** A detached group's numeric identity is usable only while this run still owns its tree. */
export function ownRunTree(child: ChildProcess, platform: NodeJS.Platform, windowsKill: () => void) {
  let treeSettled = false
  let closed = false
  let onSettled = (): void => {}
  const settle = (): void => {
    if (treeSettled) return
    treeSettled = true
    onSettled()
  }
  const kill = (): void => {
    if (treeSettled) return
    if (child.pid === undefined) { if (closed) settle(); return }
    if (platform === 'win32') {
      if (closed) { settle(); return }
      // Preserve baseline tree cleanup only while Node still owns a live leader.
      if (child.exitCode == null && child.signalCode == null) windowsKill()
      return
    }
    // No await, import or queued PID lookup between ownership check and group signal.
    try {
      process.kill(-child.pid, 0)
      if (process.kill(-child.pid, 'SIGKILL')) settle()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') settle()
      // Other failures retain deadline/cancel protection for a later attempt.
    }
  }
  child.once('close', () => {
    closed = true
    if (!treeSettled) kill()
  })
  return {
    kill,
    release: settle,
    get settled(): boolean { return treeSettled },
    get closed(): boolean { return closed },
    onSettled(callback: () => void): void { onSettled = callback; if (treeSettled) callback() },
  }
}
