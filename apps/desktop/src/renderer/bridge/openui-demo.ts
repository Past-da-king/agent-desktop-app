import type { ChatItem } from '@agent/core'

/**
 * The demo thread's generated UI (?demo=1): answers written in OpenUI Lang, as the agent writes them, so the
 * screenshots show every kind of card the chat draws. Made-up people, shops and amounts; pictures are drawn
 * inline so the demo never reaches the network.
 */

/** A soft product-style picture: a rounded object on a gradient, as an SVG data URL. */
function picture(bg1: string, bg2: string, body: string, accent: string, shape: 'mouse' | 'flat'): string {
  const object =
    shape === 'mouse'
      ? `<ellipse cx="200" cy="215" rx="92" ry="128" fill="${body}"/><path d="M200 95v88" stroke="${accent}" stroke-width="6" stroke-linecap="round"/><rect x="190" y="130" width="20" height="38" rx="10" fill="${accent}"/><ellipse cx="200" cy="350" rx="110" ry="14" fill="#000" opacity=".12"/>`
      : `<rect x="70" y="150" width="260" height="170" rx="18" fill="${body}"/><path d="M50 160 200 70l150 90" fill="none" stroke="${accent}" stroke-width="14" stroke-linejoin="round"/><rect x="110" y="200" width="70" height="60" rx="8" fill="${accent}" opacity=".85"/><rect x="220" y="200" width="70" height="120" rx="8" fill="${accent}" opacity=".6"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/>${object}</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

const MOUSE_1 = picture('#E4E0FF', '#C9C2FF', '#2A2540', '#8E84FF', 'mouse')
const MOUSE_2 = picture('#FFE2BF', '#FFC98A', '#F5F1EA', '#8A5100', 'mouse')
const MOUSE_3 = picture('#CFEBD7', '#A8D9B6', '#1E3A28', '#6FCF8E', 'mouse')
const FLAT_1 = picture('#E6E3F2', '#C9C4E0', '#FBFAFF', '#4A3FD1', 'flat')
const FLAT_2 = picture('#FFE2BF', '#F5C99A', '#FFF8F1', '#8A5100', 'flat')

const MONEY = `Here is your main account right now. The Bolt hold is still pending.

\`\`\`openui-lang
root = Stack([card])
card = Card([header, bal, sep, txHeader, tx, note, more])
header = CardHeader("Main account", "Today, 07:20")
bal = EntityList([avail, hold, pending], "default", {left: "Item", right: "Amount"})
avail = {left: "Available balance", right: "R1,240.50", rightVariant: "number"}
hold = {left: "Bolt hold", right: "-R184.20", rightVariant: "number"}
pending = {left: "Pending", right: "1 item"}
sep = Separator("horizontal", true)
txHeader = InlineHeader("Last 3 transactions", "Newest first")
tx = EntityList([t1, t2, t3], "default", {left: "Date", right: "Amount"})
t1 = {left: "Today 07:15, Bolt ride hold", right: "-R184.20", rightVariant: "number"}
t2 = {left: "Yesterday 19:12, Spar Northcliff", right: "-R312.60", rightVariant: "number"}
t3 = {left: "Yesterday 08:03, Transfer from Lerato", right: "+R500.00", rightVariant: "number"}
note = Callout("info", "The R184.20 will drop off", "Bolt holds a little more than the fare. It settles to the real price once the ride closes.")
more = FollowUpBlock([f1, f2])
f1 = FollowUpItem("Show all of October")
f2 = FollowUpItem("Warn me under R500")
\`\`\``

const FLATS = `Two 1-bed flats under R8k came up in Northcliff this morning.

\`\`\`openui-lang
root = Stack([flat1, flat2], "row")
flat1 = Card([img1, head1, facts1, btns1], src1)
img1 = ImageBlock("${FLAT_1}", "1-bed flat in Northcliff")
head1 = CardHeader("R7,200 a month", "Northcliff, 62 m2")
facts1 = EntityList([rent1, beds1, avail1, dep1], "small")
rent1 = {left: "Rent", right: "R7,200", rightVariant: "number"}
beds1 = {left: "Bedrooms", right: "1"}
avail1 = {left: "Available", right: "1 Nov"}
dep1 = {left: "Deposit", right: "R7,200", rightVariant: "number"}
btns1 = Buttons([book1, open1])
book1 = Button("Book viewing", @ToAssistant("Book a viewing", {item: "R7,200 1-bed, 62 m2", listing: "RR1000001"}))
open1 = Button("Open listing", @OpenUrl("https://flats.example/listing/RR1000001"))
src1 = [{title: "R7,200 1-bed in Northcliff", sourceName: "flats.example", url: "https://flats.example/listing/RR1000001"}]
flat2 = Card([img2, head2, facts2, btns2], src2)
img2 = ImageBlock("${FLAT_2}", "1-bed flat at Parkview")
head2 = CardHeader("R6,800 a month", "Parkview, 38 m2")
facts2 = EntityList([rent2, beds2, avail2, dep2], "small")
rent2 = {left: "Rent", right: "R6,800", rightVariant: "number"}
beds2 = {left: "Bedrooms", right: "1"}
avail2 = {left: "Available", right: "Now"}
dep2 = {left: "Deposit", right: "R6,800", rightVariant: "number"}
btns2 = Buttons([book2, open2])
book2 = Button("Book viewing", @ToAssistant("Book a viewing", {item: "R6,800 1-bed, 38 m2, Parkview", listing: "RR1000002"}))
open2 = Button("Open listing", @OpenUrl("https://flats.example/listing/RR1000002"))
src2 = [{title: "R6,800 1-bed at Parkview", sourceName: "flats.example", url: "https://flats.example/listing/RR1000002"}]
\`\`\``

const MICE = `I compared quiet wireless mice under R1,500 at two shops. Best value first.

\`\`\`openui-lang
root = Stack([p1, p2, p3, p4], "row")
p1 = Product("${MOUSE_1}", "Orbit M3 wireless mouse, quiet clicks", "R899", 4.6, 1204, "Demo Store", "R1,099", "Best value", b1)
b1 = Buttons([add1, view1])
add1 = Button("Add to cart", @ToAssistant("Add to cart", {item: "Orbit M3 wireless mouse", price: "R899", sku: "DM-1001"}))
view1 = Button("View", @OpenUrl("https://shop.example/p/DM-1001"), "secondary")
p2 = Product("${MOUSE_2}", "Glide Pro ergonomic mouse", "R1,499", 4.8, 392, "Demo Store", null, "Most comfortable", b2)
b2 = Buttons([add2, view2])
add2 = Button("Add to cart", @ToAssistant("Add to cart", {item: "Glide Pro ergonomic mouse", price: "R1,499", sku: "DM-2002"}))
view2 = Button("View", @OpenUrl("https://shop.example/p/DM-2002"), "secondary")
p3 = Product("${MOUSE_3}", "Nano travel mouse", "R349", 3.9, 87, "Sample Shop", null, null, b3)
b3 = Buttons([add3, view3])
add3 = Button("Add to cart", @ToAssistant("Add to cart", {item: "Nano travel mouse", price: "R349", sku: "SS-3003"}))
view3 = Button("View", @OpenUrl("https://sample.example/p/SS-3003"), "secondary")
p4 = Product(null, "Pebble silent mouse, no reviews yet", "R279", null, null, "Sample Shop", null, "New", b4)
b4 = Buttons([add4, view4])
add4 = Button("Add to cart", @ToAssistant("Add to cart", {item: "Pebble silent mouse", price: "R279", sku: "SS-4004"}))
view4 = Button("View", @OpenUrl("https://sample.example/p/SS-4004"), "secondary")
\`\`\``

const HELPERS = `Here is where your helpers are at.

\`\`\`openui-lang
root = Stack([card])
card = Card([head, list])
head = CardHeader("Your helpers", "2 working, 1 done")
list = ListBlock([j1, j2, j3])
j1 = ListItem("Guesthouse check", "Checking The Palms, Ocean Breeze has 2 rooms", null, "Details", @ToAssistant("Show details for the guesthouse check", {job: "guesthouse"}))
j2 = ListItem("Airline comparison", "Done: SkyHop 06:05 is the best value at R899", null, "Details", @ToAssistant("Show details for the airline comparison", {job: "airlines"}))
j3 = ListItem("Car insurance quotes", "Waiting for your ID number", null, "Details", @ToAssistant("Show details for the car insurance quotes", {job: "insurance"}))
\`\`\``

/** The message a tap on the first product's Add to cart sends, so the demo shows a button that already went. */
export const DEMO_TAPPED = 'Add to cart\n↳ Orbit M3 wireless mouse, quiet clicks · Orbit M3 wireless mouse · price: R899 · sku: DM-1001'

export function openUiDemo(now: number): ChatItem[] {
  const at = (s: number): number => now - 36_000 + s * 1000
  return [
    { id: 'ou1', createdAt: at(0), kind: 'user', text: 'How much money do I have?', meta: '{}' },
    { id: 'ou2', createdAt: at(1), kind: 'agent', text: MONEY, meta: '{}' },
    { id: 'ou3', createdAt: at(2), kind: 'user', text: 'Any 1-bed flats in Northcliff under R8k?', meta: '{}' },
    { id: 'ou4', createdAt: at(3), kind: 'agent', text: FLATS, meta: '{}' },
    { id: 'ou5', createdAt: at(4), kind: 'user', text: 'Find me a quiet wireless mouse I can add to my cart', meta: '{}' },
    { id: 'ou6', createdAt: at(5), kind: 'agent', text: MICE, meta: JSON.stringify({ taps: [DEMO_TAPPED] }) },
    { id: 'ou7', createdAt: at(6), kind: 'user', text: 'How are the helpers doing?', meta: '{}' },
    { id: 'ou8', createdAt: at(7), kind: 'agent', text: HELPERS, meta: '{}' },
    {
      id: 'ou9',
      createdAt: at(8),
      kind: 'question',
      text: 'Should I check out the Orbit M3 now, or wait for the weekend sale?',
      meta: JSON.stringify({ options: ['Check out now', 'Wait for the sale'], answer: '' }),
    },
  ]
}
