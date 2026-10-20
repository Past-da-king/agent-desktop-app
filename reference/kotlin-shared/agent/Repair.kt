package com.past9.phoneaos.agent

/**
 * Repairs a stored conversation so every assistant tool call is followed by its results.
 *
 * Every provider rejects a history where tool calls and tool results don't pair up, and keeps
 * rejecting it on every message after ("Messages with role 'tool' must be a response to a preceding
 * message with 'tool_calls'"), so the chat is stuck until the user clears their data. Causes: a run
 * cut short (calls with no results), and something else writing to the conversation mid-tool
 * (a routine, a voice call, a typed answer) so the results land after an unrelated message.
 *
 * So: each assistant tool call gets its result placed straight after it (found anywhere before the
 * next assistant message, or a stub saying it was interrupted), and any result no call claims is dropped.
 */
object Repair {
    private const val INTERRUPTED = "Interrupted before it finished (the app was closed or stopped)."

    fun repair(msgs: List<Msg>): MutableList<Msg> {
        val out = mutableListOf<Msg>()
        for ((i, m) in msgs.withIndex()) {
            if (m.role == Role.ASSISTANT) {
                out += m
                val calls = m.toolCalls
                if (calls.isEmpty()) continue
                val ids = calls.map { it.id }.toSet()
                val found = linkedMapOf<String, Block.ToolResult>()
                var j = i + 1
                while (j < msgs.size && msgs[j].role != Role.ASSISTANT) {
                    msgs[j].blocks.filterIsInstance<Block.ToolResult>().forEach { r -> if (r.callId in ids && r.callId !in found) found[r.callId] = r }
                    j++
                }
                val images = msgs.getOrNull(i + 1)?.takeIf { carriesResults(it) }?.blocks?.filterIsInstance<Block.Image>().orEmpty()
                out += Msg(Role.USER, calls.map { c -> found[c.id] ?: Block.ToolResult(c.id, INTERRUPTED, true) } + images)
            } else {
                val followsCalls = i > 0 && msgs[i - 1].role == Role.ASSISTANT && msgs[i - 1].toolCalls.isNotEmpty() && carriesResults(m)
                val rest = m.blocks.filter { it !is Block.ToolResult && !(followsCalls && it is Block.Image) }
                if (rest.isNotEmpty()) out += if (rest.size == m.blocks.size) m else Msg(m.role, rest)
            }
        }
        return out
    }

    private fun carriesResults(m: Msg) = m.role == Role.USER && m.blocks.any { it is Block.ToolResult }

    /**
     * Last resort when a provider still rejects the history's tool exchange: keep every word the user
     * and the agent said, drop the earlier tool calls and results. The current turn (after the last
     * thing the user typed) is left whole so the work in progress carries on.
     */
    fun flatten(msgs: List<Msg>): MutableList<Msg> {
        val lastUser = msgs.indexOfLast { it.role == Role.USER && it.blocks.any { b -> b is Block.Text } }.coerceAtLeast(0)
        val before = msgs.take(lastUser).mapNotNull { m ->
            val keep = m.blocks.filter { it is Block.Text || it is Block.Image }
            if (keep.isEmpty()) null else Msg(m.role, keep)
        }
        return (before + msgs.drop(lastUser)).toMutableList()
    }
}
