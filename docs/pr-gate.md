# PR gate

Settings > Git and developer (enable Developer settings if hidden) contains the gate,
memory-policy page titles and the synced event log. New installs default off. The gate
and page list sync to linked devices. Agents need the person's approval to change either,
reset the gate, or edit a configured policy page. Automatic approval cannot answer these.

Recognised review and merge actions return NOT RUN with the full current policy pages,
or a generic checklist. Missing configured pages add the generic checklist.
Draft and dry-run creation pass. Review approvals pass and are logged.

Call pr_gate_attest with gateId and attestation containing:
reviewerAgentId, testProof, trialMergeAndSuite, featureFlagStates,
environmentChecks, skippedTests, diffHygiene and finalDescription.
The evidence needs specific explanations, and testProof must contain a link or path.
The reviewer id must differ from the calling owner/label.
A pending hold lasts 24 hours, allowing time for an actual independent review.
After attestation, reissue the same command and working directory within sixty minutes.
The grant passes once and is bound to the agent/chat, tool and semantic input.
Descriptions and timeout fields do not invalidate a shell retry. A changed command,
another agent, expiry or replay is held. Pending grants disappear on restart.
The evidence is an agent's claim; the gate does not verify its truth.

Desktop and headless main/helper/project toolsets share the guard. Nested run_script
calls use those guarded tools. Clear PR writes in device_tool are held at the origin.
The origin attests once, and the app carries a short-lived, one-shot grant bound to the
remote command and the real caller across the authenticated linked-device transport.
The destination checks it once. A destination-only browser/script hit is returned as
an origin challenge so the agent can attest there, rather than facing an unknown gate.
Both devices need this feature and synced settings; older devices cannot validate
the transport grant. Destination policy still applies without a valid origin grant.
The switch is only as strong as every linked device's shell policy: this is not a sandbox.
The Claude native permission hook has a private gate handle; it is neither listed
nor callable as a model tool. Claude keeps its own shell rather than duplicate tools.
Codex keeps the person's sandbox and network policy, including danger-full-access and
network access on Run without asking. With the gate enabled, only its native shell
features are disabled so commands use the app tools. A turn already running reads this
at the next turn boundary.

For this Codex fallback, app shell commands inherit the project cwd and still default
to sixty seconds; timeoutSec can request up to six hours. run_code has a one-hour limit and preserves the
project cwd and HOME. Only shell_run and run_code output allow 150,000 characters on this path, retaining the head and tail. Other
MCP/tool results retain the 24,000-character model cap. Normal
app runs retain their existing limits. Secret-looking environment variables continue
to be removed by the app's existing policy; agents use Vault placeholders for secrets.
This is deliberate and is not native-shell environment parity.

Shell tokenisation uses shell-quote, with grammar handling for executable substitutions,
shell-fed heredocs, wrappers and control statements. Documentation strings stay inert.
Recognised paths include gh REST/GraphQL, curl/PowerShell, connector actions, browser
replays resolved from the actual tab, GitHub web writes, named create/ready/request/merge
buttons and index-only GitHub clicks. Unreadable bodies on clear PR writes are held.
Local script files are read (up to 1 MB) and held only for a detected PR write.
Unreadable script files pass and produce an audit note; syntax-only shell checks pass.
Read-only gh commands, executable lookups and unrelated build scripts pass.
A readable direct comment body file is snapshotted into inline argv before checking
and execution only for bash/sh. Bodies larger than 100 KB are snapshotted into a private
temporary file, avoiding operating-system argv limits. Native shell body files are
hashed into the attestation key, so changing their bytes invalidates the grant.
Wrapped, unreadable or Vault-
placeholder body files stay held; inspect them before attesting.

This remains a workflow guard, not a sandbox. Other DOM interactions, coordinates,
dynamic requests and opaque external programs cannot be fully inspected. Named GitHub
buttons are guarded; arbitrary UI clicks and DOM actions are not universally gated.
GitHub learned-app actions are recognised from their stored site and action name.

Audit rows are synced chat_item data with kind pr_gate in a dedicated audit chat.
They record time, actor/chat, hostname, tool, gate id, outcome and redacted evidence.
Commands, headers and request bodies are omitted. Evidence is capped to 1000 characters
per field. Repeated holds for the same pending call are not logged again. At most 500
active audit rows are kept; Settings shows the newest 100 as labelled, expandable text.

Dependency note: shell-quote and its TypeScript definitions provide the maintained
shell word/operator parser rather than growing a whitespace/regex command splitter.

## Proof continuity
The real ChatGPT-plan Codex helper proof on candidate 8ce8be1a passed: 13 minutes
22 seconds, exit 0, 50,076 output characters without truncation. It exercised the
server job path and PC-to-server SSH. The 150,000-character ceiling was not reached.
The main agent confirmed this proof remains accepted for the round-2 repairs; it is
not being repeated. The prior Windows screenshots/chat proof cover 8ce8be1a, not this
new source candidate. No release, installation or live node deployment is part of this
repair handoff. Independent reviews must pass again before release.

Linked-device command delivery is coalesced by command id before any effect runs.
Identical in-flight and completed retries return the existing result; a changed payload
under the same id is refused. The in-memory replay window covers the 20-minute queue
and execution window, with bounded reply storage. Very large or pruned replies return
an already-ran notice rather than executing again. Revoked sharing is checked before
returning a cached reply. This is not a permanent command ledger across restarts.

Remote caller identity is gate/audit metadata only: destination tools retain owner device and their own browser/card rules. The context capsule survives origin and vault wrappers. Grants allow twenty minutes of transport/queue age plus two minutes of clock skew, then use a sixty-second destination-clock consumption window. Replay retention is process-local: a host restart, expiry or oldest-finished eviction under the 4096-command bound may permit a redelivered command to execute again. Inspect state after a restart before retrying mutations.

Codex command output is capped at about 150,000 characters with both head and tail retained. Other tools remain at 24,000 characters. Comment snapshots are cleaned after execution and stale snapshots after an hour; held calls must be retried to trigger stale cleanup. Indexed GitHub read controls and focused search Enter pass when the live resolver confirms their purpose. Opaque index targets remain held.

App-owned large comment snapshots are removed immediately after a held check or completed execution. Stale in-process snapshots are pruned on the next inline call. Unreadable body files remain held when their execution folder cannot be resolved locally.
