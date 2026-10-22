# Example worker: chat DMs and mentions over Socket Mode

Not part of the app. This is the kind of script an agent writes with `worker_create` (see `docs/workers-and-triggers.md`): the app knows nothing about the chat service; everything source-specific is here.

- Runtime `node`, mode `stay`, entry `main.mjs`.
- Keys (declared as secret names, values in the app's encrypted store): `SLACK_APP_TOKEN` (app-level token with `connections:write`) and `SLACK_USER_TOKEN` (user token with `im:history mpim:history channels:history groups:history im:read mpim:read channels:read groups:read users:read`).
- The Slack app needs Socket Mode on and user events `message.im message.mpim message.channels message.groups`.
- On start it reads everything after its cursor (or since it went down), then holds a live socket and emits each direct message, group DM and mention as `message.dm`, `message.group` or `message.mention`, with `dedupeKey` = team/channel/ts.
