# Agent acts for me on approvals

Default on in Settings > Privacy and data. Task approvals from helpers, project chats and routines are stamped with their real tool call and sent to the main chat. Only the main agent gets cards_waiting and card_answer; tool execution checks owner and chat again. The answer path recomputes policy from callOrigin, never a summary label or a cached lane. Unknown, outbound messages/files, payments, personal authentication and the main agent's own cards stay with the person. Changes to the actsForMe boundary also stay with the person.

Answered for you opens from Settings and Needs you. It shows time, asker, decision and reason. Undo restores a setting, or withdraws a decline/question answer and tells the asker to ask the person next time. Approved commands have no Undo because the command already ran. Phone bundles contain labels only, no call arguments, answer payloads or setting reverts.

A sweep closes stale cards after a grace period only when there is no local waiter and no known remote owner: replaced, helper ended, answered in chat or asker progressed. Idle project cards close after two hours. Closed cards cannot be revived by a late card tap. Routed cards escalate after ten minutes or when the setting is switched off. Setting off preserves the old person-approval path.

Tests: acts-for-me.test.ts covers real-call categorisation, relabelled sends, main/helper/project restrictions, audit, Undo, off, note delivery and all stale causes. It fails on original devices d401696 because the capability does not exist. Integration verification and release evidence are in the handoff and Windows proof folder.


## Request-carried task approvals (25 November 2026)

Task approvals keep their original run identity when a learned tool runs in a paired device's browser. The command envelope carries the app-recorded owner and originating request separately from tool arguments. Both the direct device host and the replicated-command fallback preserve them. `webapp_run` and `webapp_test` are browser tools on both paths.

A request is an actual stored user message without an agent `via` sender. A turn pins that message id before it delegates. Helper metadata carries the id, including through nested and offloaded runs; project start/send handoffs carry it in the app-owned `via` record. Receivers resolve the user row, never a sentence or request id supplied in a brief, page or tool argument. Device envelopes can carry a validated label snapshot from the originating app so replication order does not erase provenance. Agent `app_action chat.send` redirects to the project messaging tool, preventing an agent-generated message from being recorded as a user-authored request.

Cards retain `meta.request = { id, at, text }`. `cards_waiting` includes its label; the existing Answered for you reason records that label and therefore reaches the phone's labels-only history bundle. Numeric timestamps remain available for local UI formatting; server-generated textual reasons explicitly label UTC. Request labels redact recognised secret shapes.

Learned operation names are split at underscores, hyphens and camel case before classification. Access/read operations can be vetted by the main agent; names such as `send_email`, `buy_credits` and `use_passkey` keep their protected meaning. `asks_first` itself is never evidence of a person-only action. The real learned call arguments are retained in the existing redacted call-origin record. Verified app-update cards from task runs can be vetted by the main agent; the signed-updater checks remain unchanged.

Protected cards still refuse main-agent approve/decline. The main agent may attach an escalation recommendation to a protected card without approving it. Setting off, Undo holds, the ten-minute fallback, stale closing, first-answer-wins and the existing outbound/payment/secret/authentication restrictions remain in force.

Focused coverage includes real Runner/ActsForMe/device-host/`callLearned` integration for both learned entry points, helper/routine/project routing, request provenance and nested handoffs, setting off, protected-action refusal, recommendations, audit labels and model-input owner spoofing. Release proof and final counts are recorded separately after review.
