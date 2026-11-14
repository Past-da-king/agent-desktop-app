# Routine claims: one slot, one brain

Part of [devices-protocol.md](devices-protocol.md) section 12 (offload). Code: `claimSlot` in
`apps/desktop/src/main/runtime/offload.ts`, called by the Scheduler inside its queue
(`apps/desktop/src/main/runtime/scheduler.ts`). Tests: `apps/desktop/test/routine-claims.test.ts`.

Every brain holds the same routines. A due slot must run on one brain only, and replication between brains can be
slower than any wait we could pick. So no brain waits for replication to learn who won. Each slot has one authority.

## The rules

1. **Slot and key.** A slot is one run of one routine. Its idempotency key is `<routine id>@<slot>`, the same on every
   brain: daily `YYYY-MM-DDTHH:mm` (the day and the routine's time, in the zone the routine is read in), one-off its
   moment, interval `i<lastRunAt of the run it follows>`. The key goes into the run (the run's prompt carries it)
   so a tool or service that takes an idempotency key, or can be asked "did this already happen", dedupes on it.
2. **Home brain = the authority.** The brain the routine's prompt is placed on, worked out as if every brain were up
   and free (so it does not move when a brain blinks): the brain named in the routine's `device` field if there is
   one, else a server before a computer. The home brain claims at once.
3. **Fence.** The claim is one synced row, `routine-<id>@<slot>`, with a fencing token in `info` (`{"fence":n}`).
   The first claim is 1; a claim written over an existing one is that fence plus 1. The token is checked twice: after
   the claim and before the slot is recorded, and again right before the run starts (the scheduler calls
   `claim.verify()`: the row must still be this brain's, at this fence). A brain that finds it no longer holds the slot
   stands down without running. The fence and key are given to the run (`runRoutine(trigger, { key, fence })`).
4. **Stand-in.** Any other brain stands down while a brain ahead of it in the order (home, then servers before
   computers, then device priority, then id) has been heard from within the lease, `SLOT_STANDIN_MS` = 15 minutes.
   "Heard from" is that brain's node beat (every 20 s, replicated). When every brain ahead of it has been silent
   for 15 minutes the lease has run out and this brain takes the slot (fence 1, or the old fence plus 1).
5. **Already claimed.** If the claim row for the slot is visible and belongs to another brain, this brain does not run
   it, whatever the beats say. If it is this brain's own, it holds it.
6. **Alone.** With Devices off, or no other brain linked, the brain runs every routine (as before).
7. **Re-checked in the queue.** The scheduler decides a slot is due, queues it, and when the job reaches the front it
   reads the routine again and checks "still enabled, still due" against the row and the clock, then claims. A routine
   run by hand (or by another brain) in between is not run again. Run now skips the due check and the claim: the person
   pressed it, here.

## What happens when brains are cut off from each other

Say the server (home) and the PC. Replication stops between them.

| Time since the cut | Server (home) | PC |
| --- | --- | --- |
| under 15 minutes | claims and runs every slot, with fence 1 | sees the server's last beat younger than 15 minutes: stands down, runs nothing |
| over 15 minutes | still claims and runs | the lease ran out: stands in, claims fence 1, runs |

So a short cut, a sleeping computer or a restart never produces two runs, and never loses a slot: the home brain runs
it, or if it is truly gone, the next brain runs it after 15 minutes. A cut that lasts longer than 15 minutes while
both brains are alive can run the same slot on both sides. That is the one window the design cannot close without a
third brain to vote (two brains cannot tell "cut off" from "off"). What limits the damage:

- Both runs carry the same key, so side effects that dedupe on it happen once.
- When the link returns, the claim rows meet. The newest write wins and a run that checks the fence before it starts
  (`verify`) finds out it lost. A run already running is not stopped.
- The slot is not run a third time: the claim row for it is there on both brains afterwards.

**A disconnected brain and side-effecting routines.** The default is that a brain only runs a slot it holds: the
home brain always (the lease is its own), any other brain only after the 15 minute stand-in. A computer that has been
offline for less than 15 minutes runs nothing that belongs to a server. To make a routine run on one brain whatever
the link does, pin it: set the routine's `device` to that brain. The pinned brain is its home and runs it even when
isolated; no other brain runs it before 15 minutes of silence.

**Catch-up when a brain reconnects.** Nothing is replayed by the claim code. A slot nobody ran stays unrun, and the
scheduler's own rules decide what happens next: daily routines run late only if `catchUp` is on (within 15 minutes
always), a one-off still runs when its moment has passed and it never ran, an interval routine runs as soon as it is
due again. If the slot was claimed (by the stand-in), the returning brain sees that claim and does not run it again;
if the claim has not replicated yet it can, and the key is what dedupes the run.

## Not covered

- A brain whose scheduler is stuck but whose beat keeps going holds its slots for as long as it beats.
- Clocks: beats are compared with the local clock, so a clock more than a few minutes off moves the 15 minutes.
- Two stand-ins (three or more brains, all of the ones ahead silent) both take a slot if neither sees the other's
  claim: the key dedupes them, the fence is only visible after the link returns.
