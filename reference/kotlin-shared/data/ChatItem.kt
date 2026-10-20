package com.past9.phoneaos.data

/** One row in the chat the user sees. `kind` decides how it renders. */
data class ChatItem(
    val id: Long = 0,
    /** user | agent | activity | helper | question | notice | branch */
    val kind: String,
    val text: String,
    val meta: String = "{}",
    val createdAt: Long = System.currentTimeMillis(),
)
