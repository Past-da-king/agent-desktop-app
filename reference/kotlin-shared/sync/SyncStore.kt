package com.past9.phoneaos.sync

/**
 * What the sync engine needs from an app's local database. Each app (Android/Room, desktop/SQLDelight)
 * implements this against its own store, so the sync protocol itself is shared and identical on both.
 *
 * Two independent watermarks:
 *  - the PUSH mark: the newest local change we have already sent to the server, so we never resend.
 *  - the PULL cursor: the newest server sequence number we have already applied, so we never re-apply.
 */
interface SyncStore {
    /** This device's stable id (used to tag HLC stamps and to skip our own echoes). */
    val deviceId: String

    /** All local rows changed strictly after [afterStamp] (exclusive), oldest first, as [Change]s. */
    suspend fun localChanges(afterStamp: String?): List<Change>

    /** Apply changes that came from the server. Implementations resolve conflicts by [HlcStamp]. */
    suspend fun applyRemote(changes: List<Change>)

    /** Newest local stamp already pushed (null = nothing pushed yet). */
    suspend fun pushMark(): String?
    suspend fun setPushMark(stamp: String)

    /** Newest server seq already applied (0 = nothing pulled yet). */
    suspend fun cursor(): Long
    suspend fun setCursor(seq: Long)
}
