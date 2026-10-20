/**
 * What the sync engine needs from an app's local database. Port of
 * reference/kotlin-shared/sync/SyncStore.kt.
 *
 * Two independent watermarks:
 *  - the PUSH mark: the newest local change already sent to the server, so we never resend.
 *  - the PULL cursor: the newest server sequence number already applied, so we never re-apply.
 */
import type { Change } from './change'

export interface SyncStore {
  /** This device's stable id (tags HLC stamps and lets us skip our own echoes). */
  readonly deviceId: string

  /** All local rows changed strictly after [afterStamp] (exclusive), oldest first. */
  localChanges(afterStamp: string | null): Promise<Change[]>

  /** Apply changes that came from the server, resolving conflicts by HLC stamp (last writer wins). */
  applyRemote(changes: Change[]): Promise<void>

  /** Newest local stamp already pushed (null = nothing pushed yet). */
  pushMark(): Promise<string | null>
  setPushMark(stamp: string): Promise<void>

  /** Newest server seq already applied (0 = nothing pulled yet). */
  cursor(): Promise<number>
  setCursor(seq: number): Promise<void>
}
