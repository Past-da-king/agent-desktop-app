package com.past9.phoneaos

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import com.past9.phoneaos.agent.AgentStatus
import com.past9.phoneaos.connections.LearnedApp
import com.past9.phoneaos.connections.LearnedTool
import com.past9.phoneaos.data.ChatItem
import com.past9.phoneaos.data.GoalRow
import com.past9.phoneaos.data.TaskRow
import com.past9.phoneaos.data.TriggerRow
import com.past9.phoneaos.miniapps.MiniAppInfo
import com.past9.phoneaos.miniapps.MiniAppsScreen
import com.past9.phoneaos.remote.LiveCard
import com.past9.phoneaos.remote.LiveCards
import com.past9.phoneaos.remote.LiveCardsUi
import com.past9.phoneaos.remote.LiveStep
import com.past9.phoneaos.remote.ProjectInfo
import com.past9.phoneaos.remote.RemoteIds
import com.past9.phoneaos.remote.RunningBlock
import com.past9.phoneaos.remote.RunningFold
import com.past9.phoneaos.remote.RunningList
import com.past9.phoneaos.ui.LocalSheetPreview
import com.past9.phoneaos.ui.ProjectSwitcherSheet
import com.past9.phoneaos.ui.screens.ApprovalSheet
import com.past9.phoneaos.ui.screens.CallScreen
import com.past9.phoneaos.ui.screens.ChatActions
import com.past9.phoneaos.ui.screens.ChatScreen
import com.past9.phoneaos.ui.screens.ConnectionsActions
import com.past9.phoneaos.ui.screens.HomeActions
import com.past9.phoneaos.ui.screens.HomeBar
import com.past9.phoneaos.ui.screens.HomeScreen
import com.past9.phoneaos.ui.screens.HomeState
import com.past9.phoneaos.ui.screens.LearnedSheet
import com.past9.phoneaos.ui.theme.AppTheme
import com.past9.phoneaos.voice.CallState
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Stills for the 10 Nov 2026 showcase posters: the real screens with an invented demo world (Sam, who runs a small
 * photo studio, and an agent called Nova). 390 x 844 at 3x (1170 x 2532), light and dark.
 * PNGs land in app/build/showcase/<name>-light|dark.png. Nothing here is real data.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34])
class ShowcaseShotsTest(private val dark: Boolean) {
    companion object {
        @JvmStatic @ParameterizedRobolectricTestRunner.Parameters(name = "dark={0}")
        fun params() = listOf(arrayOf<Any>(false), arrayOf<Any>(true))
    }
    @get:Rule val rule = createComposeRule()

    private fun shot(name: String, sheet: Boolean = false, parts: Boolean = false, content: @Composable () -> Unit) {
        RuntimeEnvironment.setQualifiers("w390dp-h844dp-xxhdpi")
        rule.mainClock.autoAdvance = false
        rule.setContent { AppTheme(dark = dark) { CompositionLocalProvider(LocalSheetPreview provides sheet) {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
                if (parts) Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) { content() } else content()
            }
        } } }
        rule.mainClock.advanceTimeBy(900)
        File("build/showcase").mkdirs()
        rule.onRoot().captureRoboImage(File("build/showcase/$name-${if (dark) "dark" else "light"}.png").path)
    }

    private val now = System.currentTimeMillis()
    private var nextId = 1L
    private fun item(kind: String, text: String, meta: JSONObject = JSONObject()) = ChatItem(id = nextId++, kind = kind, text = text, meta = meta.toString(), createdAt = now)
    private fun step(text: String, tool: String = "browser") = item("activity", text, JSONObject().put("tool", tool))

    // ---------- 1. the call: asked in chat, placed on WhatsApp, reported back ----------
    private val callCard = "I called Asanda on WhatsApp. She picked up and we spoke for a minute.\n\n```openui-lang\n" +
        "root = Stack([card])\n" +
        "card = Card([CardHeader(\"Call with Asanda\", \"WhatsApp voice, 1 min 12 s\"), EntityList(rows), Buttons([sendBtn, wordsBtn], \"column\")])\n" +
        "rows = [{left: \"Friday's shoot\", right: \"Moved to 10:00\", rightVariant: \"text\"}, {left: \"She brings\", right: \"The second light\", rightVariant: \"text\"}, {left: \"She needs\", right: \"Call sheet by Thursday\", rightVariant: \"text\"}]\n" +
        "sendBtn = Button(\"Send it to her\", @ToAssistant(\"Send Asanda the call sheet\"), \"primary\")\n" +
        "wordsBtn = Button(\"Read what was said\", @ToAssistant(\"Show me what was said on the call\"), \"secondary\")\n" +
        "```"
    @Test fun callInChat() = shot("01-call-chat") { ChatScreen(listOf(
        item("user", "Call Asanda and ask if Friday's shoot can move to 10"),
        step("Opened WhatsApp, chat with Asanda"), step("Got the call voice ready"), step("Pressed Voice call"),
        item("agent", callCard),
    ), AgentStatus(), "Nova", "Sam", false, "", {}, ChatActions()) }
    @Test fun callInChatLive() = shot("01b-call-chat-live") { ChatScreen(listOf(
        item("user", "Call Asanda and ask if Friday's shoot can move to 10"),
        item("agent", "Calling her on WhatsApp now. I'll tell you what she says."),
        step("Opened WhatsApp, chat with Asanda"), step("Got the call voice ready"), step("Pressed Voice call"),
    ), AgentStatus(true, "On a call with Asanda", 1), "Nova", "Sam", true, "", {}, ChatActions()) }

    // ---------- 2. talking to the agent itself, with live captions ----------
    private val talk = listOf(
        "in" to "Did Asanda say yes to Friday at ten",
        "out" to "She did. Ten on Friday works, and she is bringing the second light.",
        "in" to "Good. What is left for the shoot",
        "out" to "Two things. The call sheet goes to her by Thursday, and the lens you are watching dropped to four thousand two hundred. Want me to order it?",
        "in" to "Yes, order it",
    )
    @Test fun callCaptions() = shot("02-call-captions") { CallScreen("Nova", CallState(active = true, phase = "listening", mine = 0.4f, lines = talk, route = "SPEAKER"), {}, {}, {}) }
    @Test fun callSpeaking() = shot("02b-call-speaking") { CallScreen("Nova", CallState(active = true, phase = "speaking", theirs = 0.7f, lines = talk.take(4), route = "SPEAKER"), {}, {}, {}) }

    // ---------- 3. chat with a visual card ----------
    private val fares = "Three direct flights on Friday morning, all with window seats left.\n\n```openui-lang\n" +
        "root = Stack([card])\n" +
        "card = Card([CardHeader(\"Flights to Cape Town\", \"Friday morning, one adult\"), EntityList(rows), Buttons([holdBtn, moreBtn], \"column\")])\n" +
        "rows = [{left: \"SkyHop 06:05\", right: \"R 899\", rightVariant: \"number\"}, {left: \"Lumo Air 07:30\", right: \"R 1,020\", rightVariant: \"number\"}, {left: \"SkyHop 09:40\", right: \"R 1,049\", rightVariant: \"number\"}]\n" +
        "holdBtn = Button(\"Hold the 06:05\", @ToAssistant(\"Hold the 06:05\"), \"primary\")\n" +
        "moreBtn = Button(\"Show afternoon flights\", @ToAssistant(\"Show afternoon flights\"), \"secondary\")\n" +
        "```"
    @Test fun chatCards() = shot("03-chat-cards") { ChatScreen(listOf(
        item("user", "Cheapest flights to Cape Town on Friday morning, window seat"),
        step("Searched memory for seat preference", "memory"), step("Opened SkyHop"), step("Opened Lumo Air"),
        item("agent", fares),
    ), AgentStatus(), "Nova", "Sam", false, "", {}, ChatActions()) }

    // ---------- 4. helpers running in the background ----------
    private fun card(id: String, label: String, state: String = "working", line: String = "", project: String = "", pid: String = "", color: String = "iris",
                     isProject: Boolean = false, queued: Boolean = false, depth: Int = 0, waiting: Boolean = false, result: String = "", mins: Int = 4) = LiveCard(
        id = id, row = id, chat = if (isProject) "pc-$id" else "main", label = label, state = state, queued = queued, line = line, done = result, depth = depth,
        projectChat = if (isProject) "pc-$id" else "", ownerKind = if (project.isBlank()) "main" else "project", ownerName = project, ownerGlyph = "folder", ownerColor = color, ownerImage = "",
        model = "model", startedAt = now - mins * 60_000L, endedAt = if (state == "working") 0L else now - 30_000, brief = "$label: do the whole job and report back.",
        result = result, steps = listOf(LiveStep("Read 14 files", "done", now - 200_000)), ownerId = pid, waiting = waiting, activityAt = now - 20_000)
    private val projects = listOf(
        ProjectInfo("p1", "Cape Town shoot", "folder", "ocean", chats = listOf("pc-a")),
        ProjectInfo("p2", "Studio website", "folder", "mint", chats = listOf("pc-s")),
        ProjectInfo("p3", "Quote for Marlow Coffee", "folder", "ember", chats = listOf("pc-d")),
    )
    private val cards = listOf(
        card("m", "Flight search", line = "Comparing three fares", mins = 2),
        card("w", "Lens price watch", line = "Checking four shops", mins = 6),
        card("q", "Call sheet for Friday", queued = true, line = ""),
        card("a", "Cape Town shoot", project = "Cape Town shoot", pid = "p1", color = "ocean", isProject = true, line = "Booking the studio for Friday", mins = 9),
        card("b", "Find a second light", project = "Cape Town shoot", pid = "p1", color = "ocean", depth = 1, line = "Reading two rental lists", mins = 3),
        card("s", "Studio website", project = "Studio website", pid = "p2", color = "mint", isProject = true, line = "Checking the gallery on a phone", mins = 14),
        card("d", "Quote for Marlow Coffee", project = "Quote for Marlow Coffee", pid = "p3", color = "ember", isProject = true, state = "done", waiting = true, line = "", result = "The quote is ready. Send it?"),
    )
    private val ids = RemoteIds()
    private fun ui(list: List<LiveCard>) = LiveCardsUi(list, { c -> LiveCards.view(c, ids) }, {})
    private fun fold(collapsed: Boolean) = RunningFold(null).apply { set(collapsed) }
    /** The chat as the app shows it with the list open (the fold choice is kept in the app's settings). */
    @Test fun runningInChat() {
        androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>().getSharedPreferences("settings", android.content.Context.MODE_PRIVATE).edit().putString("agents_fold", "open").commit()
        shot("04-running-chat") { ChatScreen(listOf(
            item("user", "Get Friday ready: flights, a second light, and keep an eye on that lens"),
            item("agent", "On it. I'll come back when each one lands."),
        ), AgentStatus(true, "Working", 3), "Nova", "Sam", false, "", {}, ChatActions(), live = ui(cards)) }
    }
    /** The page the learned apps sheet slides up over. */
    @Test fun connections() = shot("05c-connections") { com.past9.phoneaos.ui.screens.ConnectionsScreen(com.past9.phoneaos.ui.screens.ConnectionsState(learned = learned), ConnectionsActions()) }

    // ---------- 5. learned apps ----------
    private fun tool(name: String, about: String, writes: Boolean = false) = LearnedTool(name, about, js = "return 1", readOnly = !writes)
    private val learned = listOf(
        LearnedApp("wa", "WhatsApp Web", "https://web.whatsapp.com", "Messages and voice calls from your own WhatsApp. Calls are spoken by your agent and it hears the other person.", desktop = true,
            tools = listOf(tool("voice_call", "Call a contact and talk to them", true), tool("send_message", "Send a message to a chat", true), tool("read_chat", "Read the latest messages in a chat"))),
        LearnedApp("sky", "SkyHop", "https://skyhop.example", "Flight search and fares.", tools = listOf(tool("search_flights", "Fares for a route and a day"), tool("hold_seat", "Hold a seat for 24 hours", true))),
        LearnedApp("lib", "City Library", "https://library.example.org", "Loans, renewals and holds.", tools = listOf(tool("my_loans", "What is out and when it is due"), tool("renew", "Renew a loan", true))),
        LearnedApp("lens", "Lens Market", "https://lensmarket.example", "Camera gear prices.", tools = listOf(tool("get_price", "The price of an item today"))),
        LearnedApp("print", "Paper and Ink", "https://paperandink.example", "Print orders and proofs.", tools = listOf(tool("order_status", "Where an order is"), tool("upload_proof", "Upload a proof", true))),
        LearnedApp("meal", "Meal Planner", "https://mealplanner.example.org", "The week's meals and the shopping list.", tools = listOf(tool("this_week", "This week's plan"))),
    )
    @Test fun learnedSheet() = shot("05-learned", sheet = true) { LearnedSheet(learned, ConnectionsActions(), {}) }
    @Test fun learnedSheetOpen() = shot("05b-learned-open", sheet = true) { LearnedSheet(learned, ConnectionsActions(), {}, initialOpen = "wa") }

    // ---------- 6. projects and the switcher ----------
    private val lines = mapOf("p1" to "2 min ago · Studio booked for Friday at 10", "p2" to "1 h ago · The gallery loads fast on a phone now", "p3" to "Yesterday · Quote drafted, three line items")
    @Test fun switcher() = shot("06-switcher", sheet = true) { ProjectSwitcherSheet(RunningList.switcher(projects, cards, "main"), lines, {}, onNewProject = {}, onDismiss = {}) }

    // ---------- 7. an approval ----------
    private val approval get() = item("question", "APPROVAL|Send the quote to Marlow Coffee|To: orders@marlowcoffee.example\nFor: Menu shoot, half day\nTotal: R 8,400\nAttached: Quote 0042.pdf",
        JSONObject().put("options", JSONArray(listOf("Approve", "Decline"))).put("why", "It goes out in your name.").put("whyBy", "Nova"))
    @Test fun approvalSheet() = shot("07-approval-sheet", sheet = true) { ApprovalSheet(approval, { _, _ -> }, {}) }
    @Test fun approvalInChat() = shot("07b-approval-chat") { ChatScreen(listOf(
        item("user", "Quote Marlow Coffee for the menu shoot, half day"),
        step("Read the rate card", "memory"), step("Wrote Quote 0042.pdf", "files"),
        item("agent", "The quote is drafted at **R 8,400** for a half day. It is ready to go to Marlow Coffee."),
        approval,
    ), AgentStatus(true, "Waiting for you"), "Nova", "Sam", false, "", {}, ChatActions()) }

    // ---------- 8. mini apps ----------
    private val apps = listOf(
        MiniAppInfo("week", "Week calendar", "Every calendar in one week", "clock", 1, 3, true, now - 3_600_000),
        MiniAppInfo("shoots", "Shoot board", "Bookings, call sheets and what is due", "grid", 2, 5, true, now - 7_200_000),
        MiniAppInfo("price", "Price watch", "Gear you are watching, cheapest today", "tag", 3, 2, true, now - 86_400_000L),
        MiniAppInfo("money", "Money in, money out", "Quotes, invoices and what is unpaid", "apps", 0, 4, true, now - 2 * 86_400_000L),
        MiniAppInfo("brief", "Morning brief", "Today in one screen", "sun", 0, 1, true, now - 5 * 3_600_000),
    )
    @Test fun miniApps() = shot("08-miniapps") { MiniAppsScreen(apps, {}, {}) { _, _ -> } }

    // ---------- 9. home ----------
    private val goals = listOf(GoalRow(1, "Cape Town shoot on Friday", "Marlow Coffee menu, half day"), GoalRow(2, "New studio website", ""))
    private val tasks = listOf(TaskRow(1, 1, "Book the flights", status = "done"), TaskRow(2, 1, "Find a second light", status = "doing"), TaskRow(3, 1, "Send the call sheet"),
        TaskRow(4, null, "Pay the studio deposit", dueAt = now + 86_400_000L), TaskRow(5, 2, "Pick the gallery photos"))
    @Test fun home() = shot("09-home") {
        HomeScreen(HomeState("Nova", "Sam", AgentStatus(false, "", 2),
            listOf(item("agent", "Asanda said yes to **10:00 on Friday**. The second light is sorted and the call sheet goes out on Thursday.")),
            goals, tasks, listOf(TriggerRow(1, "Morning brief", "daily", "07:00", "Brief me"), TriggerRow(2, "Lens price watch", "interval", "180", "Tell me if it drops")),
            notifications24h = 14, notifApps = 3, browserLive = false), HomeActions())
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) { HomeBar("home", {}, {}) }
    }
}
