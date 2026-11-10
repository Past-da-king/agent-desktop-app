#!/usr/bin/env python3
"""Applies the showcase demo world to a throwaway clone of agent-desktop-app (never commit the patched clone).
Usage: patch-desk.py <clone root> <dir holding showcase-demo.ts>"""
import pathlib
import re
import shutil
import sys

root = pathlib.Path(sys.argv[1]) / 'apps/desktop/src/renderer'
src = pathlib.Path(sys.argv[2])
bridge = root / 'bridge'
shutil.copy(src / 'showcase-demo.ts', bridge / 'showcase-demo.ts')

seed = (bridge / 'seed.ts').read_text()
start = seed.index('  const chat: ChatItem[] = [')
end = seed.index('    ...multiChatDemo(now),', start)
if 'showcaseChat' not in seed:
    seed = seed[:start] + '  const chat: ChatItem[] = [\n    ...showcaseChat(now),\n' + seed[end:]
    seed = seed.replace("import { openUiDemo } from './openui-demo'\n", "import { showcaseChat } from './showcase-demo'\n")
    seed = seed.replace("import { runsDemo } from './runs-demo'\n", '')
(bridge / 'seed.ts').write_text(seed)

mock = (bridge / 'mock.ts').read_text()
a = mock.index("      {\n        id: 'hacker_news',")
b = mock.index('    ]\n  : []\nconst appsListeners')
learned = '''      {
        id: 'whatsapp_web', name: 'WhatsApp Web', startUrl: 'https://web.whatsapp.com', host: 'web.whatsapp.com',
        about: 'Messages and voice calls from your own WhatsApp. Your agent speaks in the call and hears the other person.',
        trusted: false, updatedAt: Date.now() - 3_600_000,
        tools: [
          { name: 'voice_call', description: 'Call a contact and talk to them', readOnly: false },
          { name: 'send_message', description: 'Send a message to a chat', readOnly: false },
          { name: 'read_chat', description: 'The latest messages in a chat', readOnly: true },
        ],
      },
      {
        id: 'skyhop', name: 'SkyHop', startUrl: 'https://skyhop.example', host: 'skyhop.example',
        about: 'Flight search and fares. You sign in yourself; it never pays.',
        trusted: false, updatedAt: Date.now() - 86_400_000,
        tools: [
          { name: 'search_flights', description: 'Fares for a route and a day', readOnly: true },
          { name: 'hold_seat', description: 'Hold a seat for 24 hours', readOnly: false },
        ],
      },
      {
        id: 'lens_market', name: 'Lens Market', startUrl: 'https://lensmarket.example', host: 'lensmarket.example',
        about: 'Camera gear prices. No sign-in needed.',
        trusted: true, updatedAt: Date.now() - 2 * 86_400_000,
        tools: [
          { name: 'get_price', description: 'The price of an item today', readOnly: true },
          { name: 'search', description: 'Find gear by name', readOnly: true },
        ],
      },
      {
        id: 'city_library', name: 'City Library', startUrl: 'https://library.example.org', host: 'library.example.org',
        about: 'Loans, renewals and holds on your card.',
        trusted: false, updatedAt: Date.now() - 5 * 86_400_000,
        tools: [
          { name: 'my_loans', description: 'What is out and when it is due', readOnly: true },
          { name: 'renew', description: 'Renew a loan', readOnly: false },
        ],
      },
      {
        id: 'paper_and_ink', name: 'Paper and Ink', startUrl: 'https://paperandink.example', host: 'paperandink.example',
        about: 'Print orders and proofs.',
        trusted: false, updatedAt: Date.now() - 9 * 86_400_000,
        tools: [
          { name: 'order_status', description: 'Where an order is', readOnly: true },
          { name: 'upload_proof', description: 'Upload a proof', readOnly: false },
        ],
      },
'''
if 'whatsapp_web' not in mock:
    mock = mock[:a] + learned + mock[b:]
    mock = mock.replace("learned: ['example_shop']", "learned: ['skyhop', 'lens_market']").replace("learned: ['hacker_news']", "learned: ['whatsapp_web', 'city_library']")
(bridge / 'mock.ts').write_text(mock)

# One trip, one date, everywhere the demo mentions it.
swaps = [('Johannesburg to Durban, Fri 30 Oct', 'Johannesburg to Cape Town, Fri 13 Nov'), ('Friday 30 October', 'Friday 13 November'), ('Fri 30 Oct', 'Fri 13 Nov'),
         ("code: 'BA 220'", "code: 'LM 220'"), ('Durban', 'Cape Town'), ('Acme finance', 'Studio books'), ('Book Randburg DLTC, Tue 3 Nov, 08:30', 'Book the licence renewal slot, Tue 17 Nov, 08:30')]
for f in list(bridge.glob('*.ts')):
    text = f.read_text()
    new = text
    for old, to in swaps:
        new = new.replace(old, to)
    if new != text:
        f.write_text(new)

# The licence slot in another chat is already approved, so the only card waiting is the quote.
chats = (bridge / 'chats-demo.ts').read_text()
chats = chats.replace("details: 'Fee: R 250, paid at the centre', decision: ''", "details: 'Fee: R 250, paid at the centre', decision: 'approve'")
(bridge / 'chats-demo.ts').write_text(chats)

# A neutral label on the model picker, and a demo page that fills the browser card.
seed = (bridge / 'seed.ts').read_text()
seed = seed.replace("label: 'Claude plan'", "label: 'Demo plan'").replace("main: { account: 'acc_claude', model: 'fable' }", "main: { account: 'acc_claude', model: 'standard' }")
seed = seed.replace("    { time: '09:40', code: 'SH 157', fare: 'R 1,049', selected: false },\n", "    { time: '09:40', code: 'SH 157', fare: 'R 1,049', selected: false },\n"
    "    { time: '11:15', code: 'SH 163', fare: 'R 1,180', selected: false },\n    { time: '12:40', code: 'LM 224', fare: 'R 1,240', selected: false },\n"
    "    { time: '14:05', code: 'SH 169', fare: 'R 1,095', selected: false },\n    { time: '16:30', code: 'LM 230', fare: 'R 1,310', selected: false },\n"
    "    { time: '18:20', code: 'SH 175', fare: 'R 990', selected: false },\n")
(bridge / 'seed.ts').write_text(seed)

panel = (root / 'shell/Panel.tsx').read_text()
strip = '''      <div className="rt">{skyHopDemo.route}</div>
      <div style={{ display: 'flex', gap: 6, margin: '2px 0 10px' }}>
        {[['Thu 12', 'R 940'], ['Fri 13', 'R 899'], ['Sat 14', 'R 1,150'], ['Sun 15', 'R 1,020']].map(([day, from], i) => (
          <div key={day} style={{ flex: 1, padding: '6px 8px', borderRadius: 8, border: i === 1 ? '1.5px solid #0B5FC9' : '1px solid #e2e2e8', background: i === 1 ? '#EEF4FF' : '#fff' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: i === 1 ? '#0B5FC9' : '#1b1a1f' }}>{day}</div>
            <div style={{ fontSize: 10.5, color: '#55555e' }}>{from}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#55555e', margin: '0 2px 6px' }}>
        <span>8 direct flights</span>
        <span>Sorted by time</span>
      </div>
'''
foot = '''      ))}
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #e2e2e8', fontSize: 10.5, lineHeight: 1.5, color: '#77777f' }}>
        Fares are for one adult and include taxes. Window seats are shown first.
      </div>
    </div>
  )
}

function BrowserChrome({'''
if 'Sorted by time' not in panel:
    panel = panel.replace('      <div className="rt">{skyHopDemo.route}</div>\n', strip, 1)
    panel = panel.replace('      ))}\n    </div>\n  )\n}\n\nfunction BrowserChrome({', foot, 1)
(root / 'shell/Panel.tsx').write_text(panel)
print('patched')
