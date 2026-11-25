# Agent message sender rows

The row remains `kind: user` for wire, transcript and mixed-version compatibility. `meta.via` is the existing shared contract: `{from, name, chat, title?, id?, icon?: {glyph, color}}`. No database migration or environment variables are needed. Project IDs and helper IDs are recorded where known. The original text is retained.

`shared/sender.ts` owns `senderOfRow` and `isOwnMessage`. Explicit sender metadata wins. New genuine sends carry own=true, so even a person typing an app-shaped envelope remains their own message. Only anchored historical app envelopes (`[From project ...]`, `[Helper #...`, `[Helpers finished:`, `[From ..., the main agent]`) recover unmarked legacy rows. Bare historical prose cannot be safely attributed and is deliberately not guessed. No data rewrite occurs.

## Ingress audit

- Project chat start/send and message_main: existing `Runner.receive` preserves metadata; project replies now include ID/icon. Helpers and routines can message_main from the main chat and use their actual tool context.
- Agent app_action chat.send: adds trusted context as via to send options. `originWithLive` forwards it through the existing send pipeline.
- Explicit Runner.send via: stores sender AND prefixes model text. Previously only the stored row had attribution, so the model saw bare text.
- Automatic helper completion, failure, batch completion, quiet/stuck notice and desk reports: `Runner.deliver` now stores a sender row through receive. Helper envelopes recover their exact label/ID; other internal notes use system/Agent update.
- Device late results: desktop and headless callbacks explicitly use the old-compatible system sender named Linked device. Helper-owned results still go only to the owning helper; finished routine-owned results are dropped as before.
- Mid-turn receive: marks route/join and delivered=false, so interrupted delivery is recovered with its sender header. Branch hand-off text retains attribution.
- Live call hand-backs: existing callVia remains, and explicit sends now carry the same label to the model.
- Self-update resume/approval/internal notices: generic system sender through deliver, rather than fabricating the person's own words.
- Person-origin chat.send, sendOnce, dictation and mini-app user clicks retain their ordinary user rows. app_action cannot directly upsert chat_item (existing policy).
- Scheduled routine outcomes live in their existing routine cards/notifications, not fabricated user messages; event desks reach the shared helper completion boundary.

Desktop and phone render marked user rows as left-aligned neutral sender cards, distinct from the person's right-aligned bubble. The card counts as one message using the existing row ID, not one message per update. Sender IDs are in via, not meta.helper, which would hide the row as an internal helper step.

## Mixed versions

Old phones already understand via for helper/project/routine/system/main/call/worker. Those remain the emitted kinds; device callbacks use system. An old phone shows a neutral sender-labelled bubble on the right, not the new left card. New optional id/icon fields are ignored safely. The new phone also reads device/desk kinds for forward compatibility. Metadata survives the existing phone list/feed unchanged. Legacy envelope fallback is only available on updated clients.

## Proof status

Standalone shared-contract Node tests: 20/20 green; the same fixtures against the original sender implementation: 12 green, 8 red (legacy envelopes, ID and icon). These are not full Runner/browser tests.

Source syntax transpilation: zero diagnostics on changed desktop TS/TSX. git diff whitespace check passes. New tests cover legacy envelopes, genuine user prose, sender identity, automatic delivery, explicit model headers, and agent chat.send context. Android adds unit coverage and actual UserBubble Compose/Roborazzi assertions at 390 in light/dark.

Not yet proven: targeted/full suites, baseline comparison, red controls, typecheck, combined-open-PR trial, browser 1440/390 light/dark captures, Android screenshot execution. Server slots/memory were unavailable during the first bounded attempt; no test result is claimed. Both PRs must stay draft pending these checks and independent review. No release, installation or deployment.
