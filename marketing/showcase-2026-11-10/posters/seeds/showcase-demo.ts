import type { ChatItem } from '@agent/core'

/**
 * The main chat for the 10 Nov 2026 showcase stills (?demo=1). An invented world: Sam runs a small photo studio and
 * the agent is called Nova. Nothing here is real data.
 */
const MIN = 60_000

const CALL = `I called Asanda on WhatsApp from your phone. She picked up and we spoke for a minute.

\`\`\`openui-lang
root = Stack([card])
card = Card([header, facts, next])
header = CardHeader("Call with Asanda", "WhatsApp voice, 1 min 12 s")
facts = EntityList([a, b, c])
a = {left: "Friday's shoot", right: "Moved to 10:00"}
b = {left: "She brings", right: "The second light"}
c = {left: "She needs", right: "Call sheet by Thursday"}
next = Buttons([Button("Send it to her", @ToAssistant("Send Asanda the call sheet"), "primary"), Button("Read what was said", @ToAssistant("Show me what was said on the call"), "secondary")])
\`\`\``

const FARES = `Three direct flights on Friday morning, all with window seats left.

\`\`\`openui-lang
root = Stack([card])
card = Card([header, fares, next])
header = CardHeader("Flights to Cape Town", "Friday morning, one adult")
fares = EntityList([f1, f2, f3], "default", {left: "Flight", right: "Fare"})
f1 = {left: "SkyHop 06:05", right: "R 899", rightVariant: "number"}
f2 = {left: "Lumo Air 07:30", right: "R 1,020", rightVariant: "number"}
f3 = {left: "SkyHop 09:40", right: "R 1,049", rightVariant: "number"}
next = Buttons([Button("Hold the 06:05", @ToAssistant("Hold the 06:05"), "primary"), Button("Show afternoon flights", @ToAssistant("Show afternoon flights"), "secondary")])
\`\`\``

function step(id: string, at: number, text: string, tool: string): ChatItem {
  return { id, createdAt: at, kind: 'activity', text, meta: JSON.stringify({ tool, status: 'done', summary: text }) }
}

function helper(id: string, at: number, now: number, label: string, brief: string, summary: string, state: 'working' | 'done', result = ''): ChatItem[] {
  return [
    {
      id,
      createdAt: at,
      kind: 'helper',
      text: brief,
      meta: JSON.stringify({ id, label, state, summary, queued: false, startedAt: at, ...(state === 'done' ? { endedAt: now - 40_000, result } : {}), model: 'fast', modelName: 'Demo plan · fast' }),
    },
    {
      id: `${id}-s`,
      createdAt: at + 5_000,
      kind: 'activity',
      text: summary,
      meta: JSON.stringify({ tool: 'web_fetch', status: state === 'done' ? 'done' : 'running', summary, helper: id, by: label }),
    },
  ]
}

export function showcaseChat(now: number): ChatItem[] {
  const t = now - 40 * MIN
  return [
    { id: 's0', createdAt: t, kind: 'notice', text: 'Started on your phone at 09:12, continued here', meta: JSON.stringify({ from: 'phone', startedAt: '09:12' }) },
    { id: 's1', createdAt: t + MIN, kind: 'user', text: "Call Asanda and ask if Friday's shoot can move to 10", meta: JSON.stringify({ from: 'phone' }) },
    step('s2', t + MIN + 5_000, 'Opened WhatsApp, chat with Asanda', 'browser_open'),
    step('s3', t + MIN + 9_000, 'Got the call voice ready', 'browser_call_voice'),
    step('s4', t + MIN + 12_000, 'Pressed Voice call', 'browser_act'),
    { id: 's5', createdAt: t + 3 * MIN, kind: 'agent', text: CALL, meta: '{}' },
    { id: 's6', createdAt: t + 20 * MIN, kind: 'user', text: 'Good. Cheapest flights to Cape Town on Friday morning, window seat. And quote Marlow Coffee for the half day.', meta: '{}' },
    step('s7', t + 20 * MIN + 5_000, 'Searched memory for “seat preference”, 1 found', 'memory_search'),
    ...helper('h1', now - 6 * MIN, now, 'Flight search', 'Find the three cheapest direct flights from Johannesburg to Cape Town on Friday morning, window seats only.', 'Compared 3 fares', 'done', 'SkyHop 06:05 is the cheapest at R 899, with window seats left.'),
    ...helper('h2', now - 4 * MIN, now, 'Lens price watch', 'Check four shops for the 35 mm lens and say where it is cheapest today.', 'Checking the third shop', 'working'),
    ...helper('h3', now - 2 * MIN, now, 'Call sheet for Friday', 'Write the call sheet for Friday at 10:00 from the shoot notes.', 'Writing the schedule', 'working'),
    { id: 's8', createdAt: now - 3 * MIN, kind: 'agent', text: FARES, meta: '{}' },
    {
      id: 's9',
      createdAt: now - 90_000,
      kind: 'approval',
      text: 'Send the quote to Marlow Coffee',
      meta: JSON.stringify({
        summary: 'Send the quote to Marlow Coffee',
        details: 'To: orders@marlowcoffee.example\nFor: Menu shoot, half day\nTotal: R 8,400\nAttached: Quote 0042.pdf',
        decision: '',
      }),
    },
  ]
}
