package com.past9.agent.sync

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetSocketAddress
import java.security.SecureRandom
import java.sql.Connection
import java.sql.DriverManager
import java.util.Base64
import java.util.concurrent.Executors
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * The sync service: accounts + an append-only change log, one log per user.
 *
 * It is intentionally data-blind — it never learns what a "chat_item" or "memory" is, only that a row
 * with a given id changed at a given clock stamp. All merging happens on the devices, so this same
 * service can back every product the team ships, and the server holds no business logic to drift.
 */
fun main(args: Array<String>) {
    val port = System.getenv("PORT")?.toIntOrNull() ?: args.getOrNull(0)?.toIntOrNull() ?: 8790
    val dbPath = System.getenv("SYNC_DB") ?: args.getOrNull(1) ?: "sync.db"
    val store = Store(dbPath)
    val server = HttpServer.create(InetSocketAddress(port), 64).apply {
        executor = Executors.newCachedThreadPool()
        createContext("/") { ex -> route(store, ex) }
    }
    server.start()
    println("agent sync service listening on :$port (db=$dbPath)")
}

private fun route(store: Store, ex: HttpExchange) {
    val path = ex.requestURI.path
    val method = ex.requestMethod.uppercase()
    try {
        when {
            path == "/health" -> respond(ex, 200, JSONObject().put("ok", true))

            path == "/v1/auth/register" && method == "POST" -> {
                val body = readJson(ex)
                val email = body.optString("email").trim().lowercase()
                val password = body.optString("password")
                if (email.isBlank() || password.length < 6) return respond(ex, 400, err("email and a password of at least 6 characters are required"))
                val userId = store.createUser(email, password) ?: return respond(ex, 409, err("an account with that email already exists"))
                respond(ex, 200, JSONObject().put("userId", userId).put("token", store.newToken(userId)))
            }

            path == "/v1/auth/login" && method == "POST" -> {
                val body = readJson(ex)
                val userId = store.checkLogin(body.optString("email").trim().lowercase(), body.optString("password"))
                    ?: return respond(ex, 401, err("email or password is not correct"))
                respond(ex, 200, JSONObject().put("userId", userId).put("token", store.newToken(userId)))
            }

            path == "/v1/sync/push" && method == "POST" -> {
                val userId = auth(store, ex) ?: return respond(ex, 401, err("sign in first"))
                val body = readJson(ex)
                val device = body.optString("device")
                val changes = body.optJSONArray("changes") ?: JSONArray()
                val cursor = store.append(userId, device, changes)
                respond(ex, 200, JSONObject().put("cursor", cursor))
            }

            path == "/v1/sync/pull" && method == "GET" -> {
                val userId = auth(store, ex) ?: return respond(ex, 401, err("sign in first"))
                val q = parseQuery(ex.requestURI.query)
                val since = q["since"]?.toLongOrNull() ?: 0L
                // ?wait=N holds the request open (max 55s) and answers the instant something new is written for this user, so a
                // phone with the app open hears a result at once. Event-driven: the server wakes the waiter, nobody polls the database.
                val deadline = System.currentTimeMillis() + (q["wait"]?.toLongOrNull() ?: 0L).coerceIn(0, 55) * 1000
                var (changes, cursor) = store.since(userId, since, q["entity"])
                while (changes.length() == 0 && System.currentTimeMillis() < deadline) {
                    store.waitForChange(userId, deadline - System.currentTimeMillis())
                    val next = store.since(userId, since, q["entity"]); changes = next.first; cursor = next.second
                }
                respond(ex, 200, JSONObject().put("changes", changes).put("cursor", cursor))
            }

            else -> respond(ex, 404, err("no such endpoint"))
        }
    } catch (e: Exception) {
        respond(ex, 500, err(e.message ?: "server error"))
    }
}

private fun err(message: String) = JSONObject().put("error", JSONObject().put("message", message))

private fun auth(store: Store, ex: HttpExchange): Long? {
    val header = ex.requestHeaders.getFirst("Authorization") ?: return null
    val token = header.removePrefix("Bearer").trim().takeIf { header.startsWith("Bearer") } ?: return null
    return store.userFor(token)
}

private fun readJson(ex: HttpExchange): JSONObject {
    val bytes = ex.requestBody.readBytes()
    return if (bytes.isEmpty()) JSONObject() else JSONObject(String(bytes, Charsets.UTF_8))
}

private fun respond(ex: HttpExchange, code: Int, body: JSONObject) {
    val bytes = body.toString().toByteArray(Charsets.UTF_8)
    ex.responseHeaders.add("Content-Type", "application/json; charset=utf-8")
    ex.sendResponseHeaders(code, bytes.size.toLong())
    ex.responseBody.use { it.write(bytes) }
}

private fun parseQuery(query: String?): Map<String, String> =
    (query ?: "").split('&').filter { it.isNotBlank() }.mapNotNull {
        val i = it.indexOf('='); if (i < 0) null else it.substring(0, i) to java.net.URLDecoder.decode(it.substring(i + 1), "UTF-8")
    }.toMap()

/** SQLite-backed storage. One connection guarded by a lock: plenty for this workload, trivially correct. */
class Store(dbPath: String) {
    private val conn: Connection = DriverManager.getConnection("jdbc:sqlite:$dbPath").also { it.autoCommit = true }
    private val lock = Any()
    private val random = SecureRandom()
    private val hub = Any()
    private val versions = HashMap<Long, Long>()   // per user: bumped on every append, so a waiter can tell something happened

    init {
        synchronized(lock) {
            conn.createStatement().use { st ->
                st.execute("PRAGMA journal_mode=WAL")
                st.execute("CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, pw TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER NOT NULL)")
                st.execute("CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL)")
                st.execute("CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, device TEXT, entity TEXT NOT NULL, cid TEXT NOT NULL, deleted INTEGER NOT NULL, stamp TEXT NOT NULL, payload TEXT NOT NULL)")
                st.execute("CREATE INDEX IF NOT EXISTS ix_changes_user_seq ON changes(user_id, seq)")
            }
        }
    }

    fun createUser(email: String, password: String): Long? = synchronized(lock) {
        if (findUser(email) != null) return null
        val salt = ByteArray(16).also(random::nextBytes)
        val hash = hash(password, salt)
        conn.prepareStatement("INSERT INTO users(email, pw, salt, created_at) VALUES(?,?,?,?)").use { ps ->
            ps.setString(1, email); ps.setString(2, hash); ps.setString(3, Base64.getEncoder().encodeToString(salt)); ps.setLong(4, System.currentTimeMillis())
            ps.executeUpdate()
        }
        conn.createStatement().use { st -> st.executeQuery("SELECT last_insert_rowid()").use { rs -> if (rs.next()) rs.getLong(1) else null } }
    }

    fun checkLogin(email: String, password: String): Long? = synchronized(lock) {
        val row = findUser(email) ?: return null
        val salt = Base64.getDecoder().decode(row.second)
        if (hash(password, salt) != row.third) null else row.first
    }

    /** (userId, saltB64, hashB64) or null. */
    private fun findUser(email: String): Triple<Long, String, String>? {
        conn.prepareStatement("SELECT id, salt, pw FROM users WHERE email = ?").use { ps ->
            ps.setString(1, email)
            ps.executeQuery().use { rs -> if (rs.next()) return Triple(rs.getLong(1), rs.getString(2), rs.getString(3)) }
        }
        return null
    }

    fun newToken(userId: Long): String = synchronized(lock) {
        val token = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also(random::nextBytes))
        conn.prepareStatement("INSERT INTO tokens(token, user_id, created_at) VALUES(?,?,?)").use { ps ->
            ps.setString(1, token); ps.setLong(2, userId); ps.setLong(3, System.currentTimeMillis()); ps.executeUpdate()
        }
        token
    }

    fun userFor(token: String): Long? = synchronized(lock) {
        conn.prepareStatement("SELECT user_id FROM tokens WHERE token = ?").use { ps ->
            ps.setString(1, token)
            ps.executeQuery().use { rs -> if (rs.next()) rs.getLong(1) else null }
        }
    }

    /** Block until [userId] has something appended after this call began, or [ms] passes. Woken by [append], not by a timer. */
    fun waitForChange(userId: Long, ms: Long) {
        if (ms <= 0) return
        synchronized(hub) {
            val seen = versions[userId] ?: 0L
            val end = System.currentTimeMillis() + ms
            while ((versions[userId] ?: 0L) == seen) {
                val left = end - System.currentTimeMillis(); if (left <= 0) return
                (hub as Object).wait(left)
            }
        }
    }

    /** Append a batch and return the new high-water sequence for this user. */
    fun append(userId: Long, device: String, changes: JSONArray): Long = synchronized(lock) {
        val sql = "INSERT INTO changes(user_id, device, entity, cid, deleted, stamp, payload) VALUES(?,?,?,?,?,?,?)"
        conn.prepareStatement(sql).use { ps ->
            for (i in 0 until changes.length()) {
                val c = changes.getJSONObject(i)
                ps.setLong(1, userId)
                ps.setString(2, device)
                ps.setString(3, c.getString("entity"))
                ps.setString(4, c.getString("id"))
                ps.setInt(5, if (c.optBoolean("deleted")) 1 else 0)
                ps.setString(6, c.getString("stamp"))
                ps.setString(7, c.optJSONObject("payload")?.toString() ?: "{}")
                ps.addBatch()
            }
            ps.executeBatch()
        }
        synchronized(hub) { versions[userId] = (versions[userId] ?: 0L) + 1; (hub as Object).notifyAll() }
        highWater(userId)
    }

    /** All changes for a user after [since], each with its server seq, plus the new cursor. */
    fun since(userId: Long, since: Long, entity: String? = null): Pair<JSONArray, Long> = synchronized(lock) {
        val arr = JSONArray()
        conn.prepareStatement("SELECT seq, entity, cid, deleted, stamp, payload FROM changes WHERE user_id = ? AND seq > ?" + (if (entity.isNullOrBlank()) "" else " AND entity = ?") + " ORDER BY seq").use { ps ->
            ps.setLong(1, userId); ps.setLong(2, since); if (!entity.isNullOrBlank()) ps.setString(3, entity)
            ps.executeQuery().use { rs ->
                while (rs.next()) {
                    arr.put(JSONObject()
                        .put("seq", rs.getLong(1))
                        .put("entity", rs.getString(2))
                        .put("id", rs.getString(3))
                        .put("deleted", rs.getInt(4) == 1)
                        .put("stamp", rs.getString(5))
                        .put("payload", JSONObject(rs.getString(6))))
                }
            }
        }
        arr to highWater(userId)
    }

    private fun highWater(userId: Long): Long =
        conn.prepareStatement("SELECT COALESCE(MAX(seq),0) FROM changes WHERE user_id = ?").use { ps ->
            ps.setLong(1, userId)
            ps.executeQuery().use { rs -> if (rs.next()) rs.getLong(1) else 0L }
        }

    private fun hash(password: String, salt: ByteArray): String {
        val spec = PBEKeySpec(password.toCharArray(), salt, 120_000, 256)
        val key = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        return Base64.getEncoder().encodeToString(key)
    }
}
