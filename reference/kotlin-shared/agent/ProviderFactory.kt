package com.past9.phoneaos.agent

import com.past9.phoneaos.data.Provider
import org.json.JSONObject

/**
 * Builds the provider adapter for a chosen provider/key. Mirrors the phone app so the two behave the
 * same; kept here (not inside the runtime) so nothing on desktop needs the Android runtime to talk to a model.
 */
fun providerFor(
    p: Provider,
    key: String,
    baseUrl: String = "",
    allowHttp: Boolean = false,
    session: () -> String = { "desktop-" + java.util.UUID.randomUUID() },
): LlmProvider = when (p) {
    Provider.OPENCODE_GO, Provider.OPENCODE_ZEN ->
        OpenAiCompatProvider(p.name.lowercase(), key, baseUrl.ifBlank { p.baseUrl }, extraHeaders = { mapOf("x-opencode-session" to session()) }, allowHttp = allowHttp)
    Provider.ANTHROPIC -> AnthropicProvider(key, baseUrl.ifBlank { p.baseUrl }, allowHttp = allowHttp)
    Provider.DEEPSEEK ->
        OpenAiCompatProvider("deepseek", key, baseUrl.ifBlank { p.baseUrl }, extra = JSONObject().put("thinking", JSONObject().put("type", "disabled")), allowHttp = allowHttp)
    else -> OpenAiCompatProvider(p.name.lowercase(), key, baseUrl.ifBlank { p.baseUrl }, allowHttp = allowHttp)
}
