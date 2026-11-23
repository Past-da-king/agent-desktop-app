# Agent acts for me on approvals

Default on in Settings > Privacy and data. Task approvals from helpers, project chats and routines are stamped with their real tool call and sent to the main chat. Only the main agent gets cards_waiting and card_answer; tool execution checks owner and chat again. The answer path recomputes policy from callOrigin, never a summary label or a cached lane. Unknown, outbound messages/files, payments, personal authentication and the main agent's own cards stay with the person. Changes to the actsForMe boundary also stay with the person.

Answered for you opens from Settings and Needs you. It shows time, asker, decision and reason. Undo restores a setting, or withdraws a decline/question answer and tells the asker to ask the person next time. Approved commands have no Undo because the command already ran. Phone bundles contain labels only, no call arguments, answer payloads or setting reverts.

A sweep closes stale cards after a grace period only when there is no local waiter and no known remote owner: replaced, helper ended, answered in chat or asker progressed. Idle project cards close after two hours. Closed cards cannot be revived by a late card tap. Routed cards escalate after ten minutes or when the setting is switched off. Setting off preserves the old person-approval path.

Tests: acts-for-me.test.ts covers real-call categorisation, relabelled sends, main/helper/project restrictions, audit, Undo, off, note delivery and all stale causes. It fails on original devices d401696 because the capability does not exist. Integration verification and release evidence are in the handoff and Windows proof folder.
