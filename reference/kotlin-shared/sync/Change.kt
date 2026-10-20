package com.past9.phoneaos.sync

import org.json.JSONArray
import org.json.JSONObject

/**
 * One syncable row, in a form both apps understand without sharing a database schema.
 *
 * `entity` is the row's kind ("chat_item", "turn", "memory", "goal", "task", "trigger", "session"),
 * `id` a client-generated stable id (a UUID, so any device can create rows offline without collision),
 * and `payload` the full row as JSON. Deletes are tombstoned (`deleted = true`) so a delete on one
 * device is not resurrected by a stale copy on another.
 */
class Change(
    val entity: String,
    val id: String,
    val deleted: Boolean,
    val stamp: HlcStamp,
    val payload: JSONObject = JSONObject(),
    /** Server-assigned global order. 0 until the server has accepted it. */
    val seq: Long = 0,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("entity", entity)
        .put("id", id)
        .put("deleted", deleted)
        .put("stamp", stamp.encode())
        .put("payload", payload)
        .put("seq", seq)

    companion object {
        fun fromJson(o: JSONObject): Change = Change(
            entity = o.getString("entity"),
            id = o.getString("id"),
            deleted = o.optBoolean("deleted"),
            stamp = HlcStamp.decode(o.getString("stamp")) ?: HlcStamp(0, 0, "?"),
            payload = o.optJSONObject("payload") ?: JSONObject(),
            seq = o.optLong("seq"),
        )

        fun listToJson(list: List<Change>): JSONArray = JSONArray().apply { list.forEach { put(it.toJson()) } }
        fun listFromJson(arr: JSONArray): List<Change> = (0 until arr.length()).map { fromJson(arr.getJSONObject(it)) }
    }
}

object Entity {
    const val SESSION = "session"
    const val CHAT_ITEM = "chat_item"
    const val TURN = "turn"
    const val MEMORY = "memory"
    const val GOAL = "goal"
    const val TASK = "task"
    const val TRIGGER = "trigger"
}
