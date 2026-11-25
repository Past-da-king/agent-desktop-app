# PR gate

This is a cooperative workflow guard for well-meaning agents, not an unbypassable credential gate. It checks the app shell, code, engine and learned-app paths and the scoped gh shim. Existing credentials remain in place. Owner-equivalent code can read existing gh credentials or call GitHub directly; the GitHub web UI and arbitrary browser interactions can bypass it. Shell parsing is an early warning, not a security boundary.

Settings > Git and developer (enable Developer settings if hidden) contains the gate,
memory-policy page titles and the synced event log. New installs default off. The gate
and page list sync to linked devices. Agents need the person's approval to change either,
reset the gate, or edit a configured policy page. Automatic approval cannot answer these.

Recognised review and merge actions return NOT RUN with the full current policy pages,
or a generic checklist. Missing configured pages add the generic checklist.
Draft and dry-run creation pass. Review approvals require attestation.

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

## Cooperative release scope

Chosen by the main agent for Ayanda on 25 November 2026. This guard prevents accidental review actions; agents keep their ordinary owner access. The broker document is a future option only.

The early warning holds non-draft PR creation, ready, merge/auto-merge, approvals, review requests and Ready for review comments. Git pushes to the locally discovered origin default branch, main/master or branches configured with git config prGate.protectedBranches are held; feature pushes pass. Protected branches absent from that local configuration cannot be discovered without a provider read and remain a documented limitation. Normal gh reads, pipelines, clones, installs and multiline draft creates pass. Mere mentions of gh/github.com do not trigger a hold. Opaque syntax is inspected best effort for review actions, never denied solely because it names GitHub. Python and Node script files are inspected for literal GitHub writes and subprocess commands; computed targets and unsupported languages remain bypasses.

Scoped Unix gh and PowerShell gh.ps1 launchers check actual argv and cwd through a temporary private loopback channel. PowerShell array splatting avoids batch argument re-parsing; cmd.exe relies on the app warning, without a batch shim. The launcher preserves real gh streams and exit status. An attested outer call reserves a short-lived execution token carrying its parsed gh operations. Permission checks do not spend it. The shim compares parsed argv and normalized real cwd, then spends each operation once; quoting and whitespace do not change the identity. run_code operations bind their literal subprocess argv because the code sandbox selects its temporary cwd. Changed argv or another PR/action needs its own grant. PATH changes, absolute executable paths, existing credentials and direct API calls can bypass it. No BASH_ENV is replaced and no WSL launcher is installed. WSL keeps its original semantics; it has no injected execution shim from the Windows scope. Windows and WSL runtime proof is pending.

A reset/restored store recovers missing peer authority over its configured fingerprint-pinned connection before normal replication, paging until the log is drained without a 100-page cap. A reset host returns a recoverable self-row challenge, then accepts only the authenticated caller self row with the pairing roles retained alongside its pass metadata. The peer's latest row keeps its original stamps; join does not publish a locally restamped host snapshot. Missing authority is reported explicitly and the normal pull cursor is not advanced. Device fingerprints/addresses, roles and signing keys require an authority writer.

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
per field. Repeated holds for the same pending call are not logged again. At most 500 decision rows and 100 unreadable-script notes are kept; Settings shows the newest 100 as labelled, expandable text.

Dependency note: shell-quote and its TypeScript definitions provide the maintained
shell word/operator parser rather than growing a whitespace/regex command splitter.

## Proof continuity

The real ChatGPT-plan Codex helper proof on candidate 8ce8be1a passed: 13 minutes
22 seconds, exit 0, 50,076 output characters without truncation. It exercised the
server job path and PC-to-server SSH. That historical run used the former 2,000,000-character cap; it did not test the current 150,000-character cap.
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

Remote caller identity is gate/audit metadata only: destination tools retain owner device and their own browser/card rules. The context capsule survives origin and vault wrappers. Grants allow twenty minutes of transport/queue age plus two minutes of clock skew, then use a sixty-second destination-clock consumption window. The command reply cache is process-local, but consumed signed PR grants have durable receipts and cannot execute again after restart or cache eviction.

shell_run and run_code output is capped at about 150,000 characters with both head and tail retained. Other MCP tools remain at 24,000 characters. The shared shell and code output sinks also retain head and tail, so large direct tool results can include their own truncation notice before the MCP limit applies. Comment snapshots are cleaned after execution and stale snapshots after an hour; held calls must be retried to trigger stale cleanup. Indexed GitHub read controls and focused search Enter pass when the live resolver confirms their purpose. Opaque index targets remain held.

App-owned large comment snapshots are removed immediately after a held check or completed execution. Stale in-process snapshots are pruned on the next inline call. Unreadable body files remain held when their execution folder cannot be resolved locally.

Older origins may forward model-supplied transport fields, but unsigned grants are refused. Keep linked peers on the same release for attestation support. If the origin gate is off while the destination gate is on, attestations cannot be completed at the origin until its gate is enabled and settings have synced. A destination-only hold is translated to the origin when its gate is enabled, including automatically routed learned apps.


## Round-four transport hardening
Transport grants use per-brain Ed25519 signatures over id, command digest, caller, signer identity and expiry. Each brain keeps its own private key in Secrets as prGateSigningKeyV2. Only the public verification key is published on its synced device row. A hands-only destination verifies against those brain rows and does not need any signing secret. Private signing keys are never included in state bundles. Unsigned or altered grants and unknown public keys fail closed. This replaces the old shared HMAC field; older releases cannot attest across this boundary.

Rotation: call `pr_gate_rotate_key` on the originating brain. The tool asks for explicit consent with the exact secret replacement and in-flight-grant impact, and writes an audit row for both decline and completion. It generates a fresh local Secrets key, publishes only the replacement public key on the device row, and returns its public fingerprint. Device-row publication also happens at toolset startup and when the local device row becomes available. Wait for device-row replication before resuming remote calls. Other brains keep their keys. In-flight old-key grants are refused; no private key is copied. With Devices off, local gated calls still run and local key rotation waits to publish until the brain row exists. Hands-only devices cannot publish or rotate signing keys.

Agents with shell access on a brain can read its key, including the headless cipher key under the same operating-system user. This is a workflow guard, not a sandbox against that user. Replication checks protected device authority fields at the shared database boundary: only an already trusted brain may change roles or public keys. A hands or screen peer cannot promote itself or relay a replacement authority row; authority changes must arrive directly from a brain. Device writes carry per-field HLC stamps, so key publication merges independently of concurrent name, order and role changes across replicas. Self-fact refresh preserves the person’s roles and revocation. Pairing seeds the pinned host’s roles and public key from its authenticated answer before the first pull. An unknown authority sender rejects the page before pull cursor advancement or push acknowledgement; it cannot silently lose authority rows. An existing database reset without its paired authority must recover that authority before replication proceeds.

A grant is bound to the command and caller, not a destination device id. An automatic learned-app route may mint a fresh signed grant for its next hop only after an app-owned structured not-signed-in refusal established before execution. The durable receipt prevents a consumed grant from executing twice. A correctly signed consumed grant answers already ran without a new challenge, even after its execution expiry, while the twenty-four-hour durable receipt is retained. In-process duplicates receive the same notice. Expired unused grants remain held.

Before execution, the destination writes a deterministic consumed-grant receipt to its persisted store. The receipt survives process restart and is separate from the pr_gate audit retention budget. Receipts are kept for twenty-four hours, longer than a signed grant can be accepted. A repeated signed grant cannot execute again after restart. The ordinary command-reply cache remains process-local; this receipt protects gated mutations, not arbitrary ungated commands.

Each gated call receives its own context capsule, including when parallel calls share a Claude turn. Learned-app automatic routing carries the capsule through its actual routing wrapper. Resolver and policy checks always see the actual tool and arguments, so adding a device field cannot bypass policy-page protection.

## Proof limits

No credential broker, restricted OS principal or credential migration is included. Existing owner-equivalent shell/SSH access and the GitHub web UI are known bypasses. Execution tests use disposable HOME/config, empty inherited tokens, fake gh and no owner profiles. Test files compile separately from source. Runtime tests, red controls, full/combined trial suites and Windows proof wait until after 08:30 SAST Thursday 26 November 2026 through build-slot. Typechecking is not runtime proof.

## Cooperative platform limits

Windows PowerShell gh.ps1 requires script execution permission. App Windows PowerShell uses ExecutionPolicy Bypass, but pwsh and nested Restricted-policy shells may refuse the script. Windows Python/Node subprocesses resolve gh.exe and skip gh.ps1; cmd relies on the app warning. Start-Process and literal script patterns are best effort, not universal interception. Unix login profiles and Claude login snapshots can re-prepend real gh and lose the shim even for honest calls. These paths need Windows/login runtime proof and are not claimed universally covered.

An existing peer without retained pairing-role metadata cannot restore a lost host-side authority row safely and needs re-pairing. Pinned pull bootstrap currently accepts the configured peer's own claimed roles after a local reset; a hostile peer promotion is outside this cooperative release, so it is not a hostile-device security guarantee. Join records the successful pairing even when authority fetch must be retried later, and reports deferred bootstrap rather than failing a completed pairing.

Unresolvable implicit push targets, including SSH/WSL commands, pass with a soft inspection note rather than using the wrong machine's branch. Explicit protected targets still hold. Tag-only pushes pass.

### Execution reservation lifetime

Deferred grants end with their shell call, including native Bash success/failure hooks, with turn cleanup as a fallback, even if no shim call consumed them. Computed run_code inner holds use a stable scratch-independent key. When the outer code is held but no complete literal gh argv can be extracted, it directs the agent to shell_run with resolved arguments instead of issuing an unusable attestation. Native shell hooks record the engine work folder and use actor-bound exact argv within that turn when an earlier cd makes the current folder unobservable. Pairing-role recovery requires a retained pass; observed revocations and deletions invalidate it and retain a versioned deny until a later pairing from any brain. Pairing and deny versions accompany pass hashes in brain bundles; stale pairing versions cannot clear a newer deny.
