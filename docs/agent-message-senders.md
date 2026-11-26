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

- Relevant desktop regression run: 110 tests passed across 9 files (helpers/end notices, projects, busy routing/recovery, late device results, sender rows, app actions, chat rows, new-message counts).
- Final sender/action rerun after card-body polish: 32/32.
- Shared-contract standalone checks: 20/20 green; the same checks against original sender code: 12 green, 8 red (legacy envelopes, ID, icon).
- Final runtime-source typecheck: exit 0. Full suite was interrupted for priority server memory pressure: exit 143, no completed full-suite or baseline counts. No test result is claimed for that run.
- Actual renderer preview at 1440 and 390 in light/dark: 4/4 structural checks, three left cards and one own right bubble, no overflow/page errors. All four final PNGs inspected by eye: readable headers, project glyph/colour, no clipping or duplicate legacy envelope. Server /tmp/agent-sender-desktop-shots; PC C:\Users\past9\Downloads\agent\agent-sender-proof.
- Android unit and actual UserBubble Compose/Roborazzi sources added. Android execution has no completion result; no phone screenshot or APK claim. No sender Gradle daemon or queue remains.
- Combined trial attempted: desktop #9 + #19 merge, but #20 conflicts in main/devices/device-tool-host.ts before this PR is reached. Phone trial stops at old PayPal #9 against current main in MainActivity.kt, AgentRuntime.kt, Connections.kt. No combined full-suite claim.
- Staged and commit-range gitleaks clean; git diff whitespace check passed; no new environment variables, feature flags, file-mode changes or test artifacts.

Both PRs remain draft for remaining red controls, full/baseline/combined proof, Android execution and independent review. Desktop #23, phone #96. No release, installation or deployment. Runtime code was proven at 486b6fb; the final follow-up changes documentation only.
