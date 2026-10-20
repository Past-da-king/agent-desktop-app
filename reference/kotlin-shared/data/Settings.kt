package com.past9.phoneaos.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject
import java.io.File

/** How the agent is powered. Desktop has the API-key path first; the subscription path comes later. */
enum class PowerMode { NONE, API_KEY, SUBSCRIPTION }

enum class Provider(val label: String, val defaultModel: String, val baseUrl: String, val keyHint: String) {
    ANTHROPIC("Anthropic", "claude-sonnet-5-5", "https://api.anthropic.com/v1", "sk-ant-…"),
    OPENAI("OpenAI", "gpt-5", "https://api.openai.com/v1", "sk-…"),
    GEMINI("Google Gemini", "gemini-flash-latest", "https://generativelanguage.googleapis.com/v1beta/openai", "AIza…"),
    DEEPSEEK("DeepSeek", "deepseek-flash", "https://api.deepseek.com/v1", "sk-…"),
    OPENCODE_GO("OpenCode Go", "deepseek-v4.1-flash", "https://opencode.ai/zen/go/v1", "Paste your key here"),
    OPENCODE_ZEN("OpenCode Zen", "claude-haiku-4-5", "https://opencode.ai/zen/v1", "Paste your key here"),
    OPENROUTER("OpenRouter", "openrouter/auto", "https://openrouter.ai/api/v1", "sk-or-…"),
    CUSTOM("Other (OpenAI-compatible)", "", "", "Paste your key here"),
}

data class AgentSettings(
    val mode: PowerMode = PowerMode.NONE,
    val provider: Provider = Provider.ANTHROPIC,
    val model: String = Provider.ANTHROPIC.defaultModel,
    val hasKey: Boolean = false,
    val userName: String = "",
    val agentName: String = "Your agent",
    val baseUrl: String = "",
    val allowHttp: Boolean = false,
    val accent: String = "iris",
    val onboarded: Boolean = false,
    /** The signed-in sync account (null = local only, no cross-device sync). */
    val syncEmail: String? = null,
    val syncToken: String? = null,
    val syncUrl: String = "",
) {
    val ready: Boolean get() = when (mode) {
        PowerMode.API_KEY -> hasKey && model.isNotBlank()
        PowerMode.SUBSCRIPTION -> true
        PowerMode.NONE -> false
    }
}

/**
 * Desktop settings, stored as JSON under the user's home (~/.agent/settings.json). The API key and
 * the sync token live in the same file for now; moving secrets to the OS keychain is a follow-up.
 */
class SettingsStore(private val file: File = File(System.getProperty("user.home"), ".agent/settings.json")) {
    private val _state = MutableStateFlow(read())
    val state: StateFlow<AgentSettings> = _state

    private fun read(): AgentSettings {
        val o = runCatching { JSONObject(file.readText()) }.getOrDefault(JSONObject())
        val provider = runCatching { Provider.valueOf(o.optString("provider", Provider.ANTHROPIC.name)) }.getOrDefault(Provider.ANTHROPIC)
        return AgentSettings(
            mode = runCatching { PowerMode.valueOf(o.optString("mode", PowerMode.NONE.name)) }.getOrDefault(PowerMode.NONE),
            provider = provider,
            model = o.optString("model").ifBlank { provider.defaultModel },
            hasKey = o.optString("key").isNotBlank(),
            userName = o.optString("userName"),
            agentName = o.optString("agentName").ifBlank { "Your agent" },
            baseUrl = o.optString("baseUrl"),
            allowHttp = o.optBoolean("allowHttp"),
            accent = o.optString("accent").ifBlank { "iris" },
            onboarded = o.optBoolean("onboarded"),
            syncEmail = o.optString("syncEmail").ifBlank { null },
            syncToken = o.optString("syncToken").ifBlank { null },
            syncUrl = o.optString("syncUrl").ifBlank { "" },
        )
    }

    private fun raw(): JSONObject = runCatching { JSONObject(file.readText()) }.getOrDefault(JSONObject())

    private fun put(block: (JSONObject) -> Unit) {
        val o = raw().also(block)
        file.parentFile?.mkdirs()
        file.writeText(o.toString(2))
        _state.value = read()
    }

    fun apiKey(): String? = raw().optString("key").takeIf { it.isNotBlank() }

    fun setApiKey(key: String) = put { it.put("key", key.trim()) }
    fun setProvider(p: Provider) = put { it.put("provider", p.name).put("model", p.defaultModel).put("baseUrl", "") }
    fun setModel(m: String) = put { it.put("model", m.trim()) }
    fun setBaseUrl(u: String) = put { it.put("baseUrl", u.trim()) }
    fun setAllowHttp(v: Boolean) = put { it.put("allowHttp", v) }
    fun setAccent(a: String) = put { it.put("accent", a) }
    fun setAgentName(n: String) = put { it.put("agentName", n.trim().ifBlank { "Your agent" }) }
    fun setMode(m: PowerMode) = put { it.put("mode", m.name) }
    fun setOnboarded(v: Boolean) = put { it.put("onboarded", v) }

    fun setSync(email: String?, token: String?, url: String) = put {
        it.put("syncEmail", email ?: "").put("syncToken", token ?: "").put("syncUrl", url)
    }
}
