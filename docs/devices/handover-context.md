# One conversation across brains (26 Nov 2026)

Symptoms (Ayanda, phone 0.15.76, PC 0.2.146, server node 0.2.148): messages and replies not showing; the server's main
agent knew nothing of what the PC had said ("like talking to a different agent"); the phone gave up on request_approval
and browser_handoff with "The phone didn't finish ... in time".

Causes found, each with a failing test first:

1. **Plan sessions are per computer.** Claude and Codex keep their session on the machine that runs them, so the brain
   that takes a chat over starts blind. The chat rows replicate, but nothing handed them to the engine.
   Fix: `runtime/gap-note.ts` + `Runner.crossBrainNote`. Before a plan turn, everything written in the chat since this
   computer's engine last finished a turn here (what he said, what the other brain answered, its tool steps and their
   results) is put in front of his message as one note. A computer that answered everything itself gets none. A first
   turn here carries the newest 30 lines of conversation. The mark is `local:ctx_to:<chat>` (this computer only).
   Tests: `cross-brain-context.test.ts`, `handover-e2e.test.ts` (two Runners over the real Replicator, PC clock 35 min slow).
2. **A person got a machine's deadline.** A command to another device waited 120 s unless it was a browser tool; the
   phone itself waits 10 minutes for him. `deadlineFor` (device-tools.ts) gives request_approval, ask_user and
   browser_handoff ten minutes on the calling side and on the device side. Test: `human-deadline.test.ts`.
3. **Cross-computer times used the operating system's clock.** Lease heartbeats, command expiry, last-seen and offload
   rows were stamped with `Date.now`. With the PC 35 minutes slow, the server read every PC lease as long dead and every
   command the PC queued as already expired. They now default to `appNow` (the corrected app clock, clock-skew.md).
   Test: `cross-node-time.test.ts`.
4. **The phone showed nothing until a brain answered.** Phone repo `fix/echo-sent-message`: the message is on screen at
   once under the id the computer will give its row (`send-<sendId>`), so the real row replaces it in place.

Server memory: builds started through `~/bin/build-slot` now run with oom_score_adj 800, so the kernel kills a build
before the node that answers him.
