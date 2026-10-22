# Example worker: chat DMs and mentions over Socket Mode

Not part of the app. This is the kind of script an agent writes with `worker_create` (see `docs/workers-and-triggers.md`): the app knows nothing about the chat service; everything source-specific is here.

- Runtime `node`, mode `stay`, entry `main.mjs`.
- Keys (declared as secret names, values in the app's encrypted store): `SLACK_APP_TOKEN` (app-level token with `connections:write`) and `SLACK_USER_TOKEN` (user token with `im:history mpim:history channels:history groups:history im:read mpim:read channels:read groups:read users:read`).
- The Slack app needs Socket Mode on and user events `message.im message.mpim message.channels message.groups`.
- It emits the STATE of a conversation, not single messages: for a DM, group DM, or a thread the person is in or mentioned in, `dm|group|mention` + `.open` (who is waiting, since when) or `.closed` (they replied, when, what they said). Their own messages (in the thread, or top-level in the channel after a mention) close an ask. Bots never count as waiting.
- `dedupeKey` = team/channel/thread/latest-ts, so a conversation that moves on is looked at again and one they answered stops coming back.
- On start it reads everything after its cursor (or since it went down), then holds a live socket.
