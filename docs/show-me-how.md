# Show me how

You ask "how do I do X". On whatever window you are on (Chrome, any desktop program), a ring and a short label
appear on the next thing to use. You click it yourself. The next ring appears at once. Nothing is ever clicked or
typed for you, and screen sharing does not see the ring.

Code: `apps/desktop/src/main/showme/`. Tests: `apps/desktop/test/showme-*.test.ts`.

## How to start one

- **Quick chat bar** (the Quick chat shortcut). A line that starts as a how-to ("how do I...", "show me how...",
  "where is...", or `/show ...`) is shown on screen instead of being sent to the chat. The hint under the box says
  which of the two Enter will do before you press it. The Show me chip does the same for any line, and Ctrl+Enter
  always sends to the chat.
- **An agent**: the `screen_guide` tool, with `question` (it finds the route) or `steps` (the agent knows the route).

The walk runs on the window that was in front when the shortcut fired, never on the Agent app's own windows.

While a walk runs: Esc stops it. The label has I did it and Skip buttons, and two shortcuts do the same (Settings,
Advanced: "Skip a step shortcut" and "I did it shortcut"). They are held only while a walk runs.

## How a walk works

1. **The window.** The moment the shortcut fires, the window in front is noted (`ShowMeService.noteForeground`),
   before the bar takes the focus.
2. **The route.** A matching skill is looked up by the window's program, its title and, for a browser, the page
   address, together with the question (`skills.ts`). Sources: memory pages of kind `skill` or `how-to` that are
   open, and learned apps (their about text and start address). One model call turns question + skill + what is on
   screen into ordered steps (`planner.ts`). Each step names an element the way the screen shows it.
3. **The loop** (`walk.ts`). For the current step: the screen reader's own lookup by name, then a match on the list
   of elements, then (only if those miss) the small model picks from the list, then a picture of the window as the
   last resort. The ring follows the element when the page scrolls.
4. **Your click is the feedback.** A left click inside the ring advances. A click anywhere else does nothing and is
   never blocked. A fill step advances on your paste (or on your own typing once you leave the field).
5. **The next ring is ready before you click.** While you are on step N, step N+1 is already looked up when its
   element is on screen, so your click puts the next ring up with no model call and no wait. When the element only
   appears after your click (a menu opening), the lookup is polled for a moment. A ring that was looked up ahead is
   checked against the screen right after your click.
6. **When the screen surprises it.** A missing target is planned again from what IS on screen, at most twice. After
   that the label says what it could not find; you can do it and press I did it. If the thing turns up late (a slow
   page), the ring moves to it.
7. **Another program.** Switch to something else and the ring hides; nothing of that program is read or sent. Come
   back and the ring is back. A window your own click opened (a dialog) is where the walk goes on.

## Speed

Measured in the tests with a fake screen (`showme-walk.test.ts` prints the numbers):

| Case | Click to next ring |
|---|---|
| Route known, next element already on screen | about 1 ms, no model call |
| Route known, element appears 30 ms after the click | about 35 to 50 ms, no model call |
| No skill, the model has to pick the element (model answers in 150 ms) | settle time + the model's answer |

The target is under 500 ms when a skill route exists. The model is only in the path when a step's name is not on
screen, which is what a good skill page prevents.

## The model

A small fast one, never the big model. Settings, Agents and helpers, "Model that shows you how". Automatic means:
the account the main chat uses when it is a key account, else the first key account (a direct call answers in well
under a second; starting a plan's engine takes seconds), else the plan. On that account, the smallest fast model it
lists today. No model id is written in the code (`guide-model.ts`).

## Privacy

- What is on screen (element names and roles, and a picture only as the last resort) goes to your own AI account
  and nowhere else.
- A field's value is never sent to a model. A password field's value is never read at all.
- The picture for the model is written to a temp file for the call and deleted right after.
- The session log keeps step names and outcomes only, in memory, for the last 20 walks. It has the same shape as
  the in-app guide's log (`browser/guide-log.ts`).
- Clipboard fill: a known value goes on your clipboard and the label says "Field: value, press Ctrl+V". A secret
  (a `{{vault:REF}}` value, or `sensitive: true`) is never shown or kept, and the clipboard is cleared after your
  paste or when the walk ends. After a plain value, what you had on the clipboard comes back.
- The ring is drawn by the shared guide overlay (`main/overlay/`), which screen sharing does not capture.

## How to write a skill page that guides well

A skill page is a memory page of kind `skill` (or `how-to`). The planner reads it as text, so write it for a small
model in a hurry.

1. **Name the product in the title**, the way its window title shows it: "Acme Desk: how to do anything (guided)".
   The lookup matches the title, the aliases and the topics against the window title and the program name.
2. **Write the site's address in the body** (`desk.acme-example.io`). For a browser window the address is the
   strongest match there is.
3. **Put exact element names in backticks**: `Create pixel`, `Send Invite`, `More options`. Copy them from the
   screen letter for letter, including icon buttons that only have an accessible name. A step's name is a lookup;
   a right name means no model call for that step.
4. **Write playbooks as routes**: "Invite a member: `More options`, `Settings`, `Members`, `Invite`, field
   `Email address`, `Send Invite`." One line per task, in click order.
5. **Say where things really open.** "Settings is a dialog, not a page: `More options` then `Settings`." If an
   address is a dead end, say so, so the planner gives the clicks and not a link.
6. **Name fields that take a value** ("field `Pixel name`"), so a known value becomes a clipboard fill.
7. **Add the role when a name is shared**: "the `Role` combobox", "the second `Delete`".
8. **Keep gotchas short and concrete**: slow pages, names that changed, things that write live.
9. **Keep it current.** Element names change when the product ships. A stale name costs one model call and maybe a
   re-plan; a page that is mostly stale is worse than none.

The first 12,000 characters are read. Put the map and the playbooks first.

A walk that finished with no skill page says so in the tool's answer; save its route as a skill page and the next
walk on that window is instant.

## Integration notes

- The screen reader is the seam with the native layer: `showme/screen.ts`. The app gets its reader from
  `showme/reader.ts` (one line to change when `showme/native/` exports `createScreenReader`). Until then a walk
  says "not available on this computer yet" and nothing is sent anywhere.
- Coordinates: the reader speaks physical pixels, the overlay speaks DIPs per display. `coords.ts` converts with
  each display's own scale and its two origins (`screen.dipToScreenRect` on Windows). Tested at 100, 125 and 150
  percent and with a second display at a negative origin.
