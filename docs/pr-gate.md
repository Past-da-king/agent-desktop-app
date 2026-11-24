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
calls use those guarded tools. A device_tool call is checked at the destination.
The Claude native permission hook has a private gate handle; it is neither listed
nor callable as a model tool. Claude keeps its own shell rather than duplicate tools.
Codex keeps the person's sandbox and network policy, including danger-full-access and
network access on Run without asking. With the gate enabled, only its native shell
features are disabled so commands use the app tools. A turn already running reads this
at the next turn boundary.

For this Codex fallback, app shell commands inherit the project cwd and have a one-hour
default, up to six hours explicitly. run_code has a one-hour limit and preserves the
project cwd and HOME. Shell, code and MCP output allow two million characters. Normal
app runs retain their existing limits. Secret-looking environment variables continue
to be removed by the app's existing policy; agents use Vault placeholders for secrets.
This is deliberate and is not native-shell environment parity.

Shell tokenisation uses shell-quote, with grammar handling for executable substitutions,
shell-fed heredocs, wrappers and control statements. Documentation strings stay inert.
Recognised paths include gh REST/GraphQL, curl/PowerShell, connector actions, browser
replays resolved from the actual tab, GitHub web writes, named create/ready/request/merge
buttons and index-only GitHub clicks. Unreadable request bodies and shell input are held.
A readable direct comment body file is snapshotted into inline argv before checking
and execution, so the checked bytes are the bytes sent. Wrapped, unreadable or Vault-
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
