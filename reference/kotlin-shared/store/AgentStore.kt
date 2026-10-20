package com.past9.phoneaos.store

import com.past9.phoneaos.data.ChatItem
import com.past9.phoneaos.sync.Change
import com.past9.phoneaos.sync.Entity
import com.past9.phoneaos.sync.Hlc
import com.past9.phoneaos.sync.HlcStamp
import com.past9.phoneaos.sync.SyncStore
import org.json.JSONObject
import java.io.File
import java.sql.Connection
import java.sql.DriverManager
import java.util.UUID

/**
 * The desktop app's local database (SQLite). Holds the chat and the sync bookkeeping, and implements
 * [SyncStore] so the shared [com.past9.phoneaos.sync.SyncEngine] can push/pull it unchanged.
 *
 * Every row carries a `cid` (a client id, stable across devices) and a `stamp` (an HLC time), which is
 * what makes phone and desktop converge: the same logical row has the same cid on both, and the greater
 * stamp wins.
 */
class AgentStore(dbFile: File) : SyncStore {
    private val conn: Connection = run {
        dbFile.parentFile?.mkdirs()
        DriverManager.getConnection("jdbc:sqlite:${dbFile.absolutePath}").also { it.autoCommit = true }
    }
    private val lock = Any()

    override val deviceId: String

    init {
        synchronized(lock) {
            conn.createStatement().use { st ->
                st.execute("PRAGMA journal_mode=WAL")
                st.execute(
                    """
                    CREATE TABLE IF NOT EXISTS chat_items(
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      cid TEXT NOT NULL UNIQUE,
                      kind TEXT NOT NULL,
                      text TEXT NOT NULL,
                      meta TEXT NOT NULL DEFAULT '{}',
                      created_at INTEGER NOT NULL,
                      stamp TEXT NOT NULL,
                      deleted INTEGER NOT NULL DEFAULT 0
                    )
                    """.trimIndent()
                )
                st.execute("CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL)")
            }
        }
        deviceId = kv("device_id") ?: UUID.randomUUID().toString().also { kv("device_id", it) }
    }

    private fun kv(k: String): String? =
        conn.prepareStatement("SELECT v FROM kv WHERE k = ?").use { ps -> ps.setString(1, k); ps.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null } }

    private fun kv(k: String, v: String) {
        conn.prepareStatement("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").use { ps -> ps.setString(1, k); ps.setString(2, v); ps.executeUpdate() }
    }

    // ---- chat ----

    fun chat(): List<ChatItem> = synchronized(lock) {
        val out = mutableListOf<ChatItem>()
        conn.createStatement().use { st ->
            st.executeQuery("SELECT id, kind, text, meta, created_at FROM chat_items WHERE deleted = 0 ORDER BY id").use { rs ->
                while (rs.next()) out += ChatItem(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getLong(5))
            }
        }
        out
    }

    /** Append a chat row and record the change for sync. Returns its local id. */
    fun addChat(kind: String, text: String, metaJson: String = "{}", at: Long = System.currentTimeMillis()): Long = synchronized(lock) {
        val cid = UUID.randomUUID().toString()
        val stamp = hlc().now()
        conn.prepareStatement("INSERT INTO chat_items(cid, kind, text, meta, created_at, stamp) VALUES(?,?,?,?,?,?)").use { ps ->
            ps.setString(1, cid); ps.setString(2, kind); ps.setString(3, text); ps.setString(4, metaJson); ps.setLong(5, at); ps.setString(6, stamp.encode())
            ps.executeUpdate()
        }
        lastRowId()
    }

    fun updateChatText(id: Long, text: String, metaJson: String) = synchronized(lock) {
        val stamp = hlc().now()
        conn.prepareStatement("UPDATE chat_items SET text = ?, meta = ?, stamp = ? WHERE id = ?").use { ps ->
            ps.setString(1, text); ps.setString(2, metaJson); ps.setString(3, stamp.encode()); ps.setLong(4, id); ps.executeUpdate()
        }
    }

    fun clear() = synchronized(lock) { conn.createStatement().use { it.execute("DELETE FROM chat_items") } }

    private fun lastRowId(): Long = conn.createStatement().use { st -> st.executeQuery("SELECT last_insert_rowid()").use { rs -> if (rs.next()) rs.getLong(1) else 0 } }

    // ---- sync bookkeeping ----

    private var hlcClock: Hlc? = null

    private fun hlc(): Hlc = hlcClock ?: Hlc(deviceId).also { hlcClock = it }

    override suspend fun localChanges(afterStamp: String?): List<Change> = synchronized(lock) {
        val out = mutableListOf<Change>()
        val sql = if (afterStamp == null)
            "SELECT cid, kind, text, meta, created_at, stamp, deleted FROM chat_items ORDER BY stamp"
        else
            "SELECT cid, kind, text, meta, created_at, stamp, deleted FROM chat_items WHERE stamp > ? ORDER BY stamp"
        conn.prepareStatement(sql).use { ps ->
            if (afterStamp != null) ps.setString(1, afterStamp)
            ps.executeQuery().use { rs ->
                while (rs.next()) {
                    val stamp = HlcStamp.decode(rs.getString(6)) ?: continue
                    out += Change(
                        entity = Entity.CHAT_ITEM,
                        id = rs.getString(1),
                        deleted = rs.getInt(7) == 1,
                        stamp = stamp,
                        payload = JSONObject()
                            .put("kind", rs.getString(2)).put("text", rs.getString(3))
                            .put("meta", rs.getString(4)).put("createdAt", rs.getLong(5)),
                    )
                }
            }
        }
        out
    }

    override suspend fun applyRemote(changes: List<Change>) = synchronized(lock) {
        for (c in changes) {
            if (c.stamp.device == deviceId) continue
            hlc().observe(c.stamp)
            when (c.entity) {
                Entity.CHAT_ITEM -> applyChat(c)
            }
        }
    }

    private fun applyChat(c: Change) {
        val existing = conn.prepareStatement("SELECT stamp FROM chat_items WHERE cid = ?").use { ps ->
            ps.setString(1, c.id); ps.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
        }
        // Last writer wins: ignore a copy that is older than what we already hold.
        val existingStamp = existing?.let { HlcStamp.decode(it) }
        if (existingStamp != null && existingStamp >= c.stamp) return
        val p = c.payload
        if (existing == null) {
            conn.prepareStatement("INSERT INTO chat_items(cid, kind, text, meta, created_at, stamp, deleted) VALUES(?,?,?,?,?,?,?)").use { ps ->
                ps.setString(1, c.id); ps.setString(2, p.optString("kind")); ps.setString(3, p.optString("text"))
                ps.setString(4, p.optString("meta", "{}")); ps.setLong(5, p.optLong("createdAt", System.currentTimeMillis()))
                ps.setString(6, c.stamp.encode()); ps.setInt(7, if (c.deleted) 1 else 0); ps.executeUpdate()
            }
        } else {
            conn.prepareStatement("UPDATE chat_items SET kind=?, text=?, meta=?, created_at=?, stamp=?, deleted=? WHERE cid=?").use { ps ->
                ps.setString(1, p.optString("kind")); ps.setString(2, p.optString("text")); ps.setString(3, p.optString("meta", "{}"))
                ps.setLong(4, p.optLong("createdAt", System.currentTimeMillis())); ps.setString(5, c.stamp.encode())
                ps.setInt(6, if (c.deleted) 1 else 0); ps.setString(7, c.id); ps.executeUpdate()
            }
        }
    }

    override suspend fun pushMark(): String? = synchronized(lock) { kv("push_mark") }
    override suspend fun setPushMark(stamp: String) = synchronized(lock) { kv("push_mark", stamp) }
    override suspend fun cursor(): Long = synchronized(lock) { kv("cursor")?.toLongOrNull() ?: 0L }
    override suspend fun setCursor(seq: Long) = synchronized(lock) { kv("cursor", seq.toString()) }
}
