package com.past9.phoneaos.sync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** What the UI shows about sync. */
data class SyncStatus(
    val signedIn: Boolean = false,
    val syncing: Boolean = false,
    val lastSyncedAt: Long? = null,
    val error: String? = null,
    val pendingPush: Int = 0,
)

/**
 * Drives sync for one device: push what is new locally, pull what is new remotely, apply, repeat.
 *
 * Offline-first: everything works with no network; when the service is reachable again the next pass
 * reconciles. Runs are serialised by a mutex so a manual "sync now" and the timer never overlap.
 */
class SyncEngine(
    private val store: SyncStore,
    private val client: () -> SyncClient?,
    private val scope: CoroutineScope,
    /** Called after remote changes are applied, so the UI reloads. */
    private val onApplied: suspend () -> Unit = {},
) {
    private val _status = MutableStateFlow(SyncStatus())
    val status: StateFlow<SyncStatus> = _status

    private val lock = Mutex()
    private var loop: Job? = null

    /** One full pass. Safe to call at any time; returns false if it could not reach the service. */
    suspend fun syncOnce(): Boolean = lock.withLock {
        val c = client() ?: return@withLock false
        _status.value = _status.value.copy(syncing = true, error = null)
        try {
            val pending = store.localChanges(store.pushMark())
            _status.value = _status.value.copy(pendingPush = pending.size)
            if (pending.isNotEmpty()) {
                client()?.push(store.deviceId, pending)
                store.setPushMark(pending.maxOf { it.stamp }.encode())
            }
            val pulled = c.pull(store.cursor())
            if (pulled.changes.isNotEmpty()) {
                store.applyRemote(pulled.changes)
                onApplied()
            }
            store.setCursor(pulled.cursor)
            _status.value = _status.value.copy(syncing = false, lastSyncedAt = System.currentTimeMillis(), pendingPush = 0, error = null)
            true
        } catch (e: SyncException) {
            _status.value = _status.value.copy(syncing = false, error = e.message, pendingPush = store.localChanges(store.pushMark()).size)
            false
        }
    }

    /** Start a background pass every [everyMs]. Idempotent. */
    fun start(everyMs: Long = 20_000) {
        if (loop?.isActive == true) return
        loop = scope.launch {
            while (isActive) {
                syncOnce()
                delay(everyMs)
            }
        }
    }

    fun stop() { loop?.cancel(); loop = null }

    fun markSignedIn(signedIn: Boolean) { _status.value = _status.value.copy(signedIn = signedIn) }
}
