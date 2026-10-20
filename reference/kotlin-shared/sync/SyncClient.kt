package com.past9.phoneaos.sync

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Talks to the (multi-tenant) sync service. Every user has their own account and their changes are
 * isolated to it server-side; this client only ever sees the signed-in account's data.
 *
 * The service is deliberately dumb: it stores changes in arrival order and hands them back by
 * sequence number. All conflict resolution is done on the devices by [HlcStamp], so the server
 * never has to understand the app's data and the same server can serve every future product.
 */
class SyncClient(
    baseUrl: String,
    private val token: String,
    private val http: OkHttpClient = defaultHttp,
) {
    val base = baseUrl.trimEnd('/')

    private val JSON = "application/json".toMediaType()

    data class Pulled(val changes: List<Change>, val cursor: Long)

    /** Push local changes; returns the server-assigned sequence cursor after accepting them. */
    fun push(device: String, changes: List<Change>): Long {
        val body = JSONObject().put("device", device).put("changes", Change.listToJson(changes))
        return call("POST", "/v1/sync/push", body).optLong("cursor")
    }

    /** Everything the server has accepted since [since]. */
    fun pull(since: Long): Pulled {
        val res = call("GET", "/v1/sync/pull?since=$since")
        return Pulled(Change.listFromJson(res.optJSONArray("changes") ?: JSONArray()), res.optLong("cursor"))
    }

    private fun call(method: String, path: String, body: JSONObject? = null): JSONObject {
        val builder = Request.Builder().url("$base$path")
            .header("Authorization", "Bearer $token")
            .header("User-Agent", USER_AGENT)
        if (body != null) builder.method(method, body.toString().toRequestBody(JSON))
        else builder.method(method, null)
        return try {
            http.newCall(builder.build()).execute().use { res ->
                val text = res.body?.string().orEmpty()
                if (!res.isSuccessful) throw SyncException(res.code, text.take(300))
                if (text.isBlank()) JSONObject() else JSONObject(text)
            }
        } catch (e: IOException) {
            throw SyncException(0, e.message ?: "network error")
        }
    }

    companion object {
        const val USER_AGENT = "agent-sync/1 (multi-platform)"

        /** Create an account; returns (userId, token). Throws [SyncException] if the email is taken. */
        fun register(baseUrl: String, email: String, password: String): Pair<Long, String> =
            authCall(baseUrl, "/v1/auth/register", email, password)

        /** Sign in to an existing account. Throws [SyncException] 401 when the details are wrong. */
        fun login(baseUrl: String, email: String, password: String): Pair<Long, String> =
            authCall(baseUrl, "/v1/auth/login", email, password)

        private fun authCall(baseUrl: String, path: String, email: String, password: String): Pair<Long, String> {
            val body = JSONObject().put("email", email).put("password", password)
            val req = Request.Builder().url(baseUrl.trimEnd('/') + path)
                .header("Content-Type", "application/json").header("User-Agent", USER_AGENT)
                .post(body.toString().toRequestBody("application/json".toMediaType())).build()
            return try {
                defaultHttp.newCall(req).execute().use { res ->
                    val text = res.body?.string().orEmpty()
                    if (!res.isSuccessful) throw SyncException(res.code, text.take(300))
                    val o = JSONObject(text)
                    o.optLong("userId") to o.optString("token")
                }
            } catch (e: IOException) {
                throw SyncException(0, e.message ?: "network error")
            }
        }

        val defaultHttp: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(20, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(60, TimeUnit.SECONDS)
                .build()
        }
    }
}

class SyncException(val status: Int, message: String) : Exception(message)
