/**
 * Words into one of the app's own windows, never a wait that never ends.
 *
 * `webContents.insertText` answers through the window's renderer. When that renderer crashes or the window goes
 * while the words are on their way (27 Oct 2026: the chat window crashed 2 s after a dictation stopped), the
 * promise never settles, and dictation sat in "typing" for good: the shortcut and the message box microphone did
 * nothing until the app restarted. Here the insert ends as soon as the renderer goes, the window is destroyed or
 * a short limit passes, and the caller falls back to the clipboard.
 */
export interface InsertTarget {
  insertText(text: string): Promise<void>
  isDestroyed(): boolean
  isCrashed?(): boolean
  once(event: 'render-process-gone' | 'destroyed', listener: () => void): unknown
  removeListener(event: 'render-process-gone' | 'destroyed', listener: () => void): unknown
}

export type InsertResult = 'inserted' | 'gone' | 'timeout' | 'failed'

/** How long the words may take to go into one of the app's windows before they go to the clipboard instead. */
export const INSERT_LIMIT_MS = 5000

export function insertBounded(target: InsertTarget, text: string, limitMs = INSERT_LIMIT_MS): Promise<InsertResult> {
  if (target.isDestroyed() || target.isCrashed?.() === true) return Promise.resolve('gone')
  return new Promise((resolve) => {
    let done = false
    const onGone = (): void => finish('gone')
    const timer = setTimeout(() => finish('timeout'), limitMs)
    function finish(result: InsertResult): void {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        target.removeListener('render-process-gone', onGone)
        target.removeListener('destroyed', onGone)
      } catch {
        // A destroyed target may refuse; nothing to undo.
      }
      resolve(result)
    }
    target.once('render-process-gone', onGone)
    target.once('destroyed', onGone)
    let work: Promise<void>
    try {
      work = target.insertText(text)
    } catch {
      finish('failed')
      return
    }
    work.then(
      () => finish('inserted'),
      () => finish('failed'),
    )
  })
}
