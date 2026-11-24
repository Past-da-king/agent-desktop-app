# PR gate

Settings > Git and developer (enable Developer settings if hidden) has a PR gate switch,
an editable list of memory page titles and a synced event log. New installs default off.
Both settings are freely editable through settings_get/settings_set.

Recognised review actions are held as a tool result, without an approval card.
The result includes the full current matching memory pages, or a generic checklist.
A missing requested page also adds the generic checklist.

Call pr_gate_attest with gateId and attestation:
reviewerAgentId, testProof, trialMergeAndSuite, featureFlagStates,
environmentChecks, skippedTests, diffHygiene and finalDescription.
Each evidence field needs a specific explanation. A legitimate absence should explain
what was inspected and why it does not apply, rather than say n/a.
The reviewer id must differ from the calling owner/label.
Reissue the identical tool name and arguments in the same agent/chat within ten
minutes of the original hold. It passes once. A changed call, another agent, expiry
or replay is held again. Pending grants are local and disappear on restart.
Attestation is a signed-in agent's claim, not an independent validation of its truth.

Toolsets shared by desktop and headless runs wrap before execution and before device
routing. Nested run_script calls use those same tools. Claude native command permissions
ask the same gate through pr_gate_check. Codex native shell is disabled while the gate
is on, so commands use app tools; app file/code tools remain available under the existing
computer policy. This applies to main, helper and project runs.

Detection recognises explicit gh commands, common shell wrappers/chains, GitHub REST
and GraphQL, curl/PowerShell requests, literal fetch calls and GitHub connector slugs.
This is a workflow guard, not a sandbox: arbitrary opaque executables, dynamically built
requests, encoded commands and external programs are not fully statically inspectable.
An already-running native Codex turn reads the setting at its next turn boundary.

Audit events use synced chat_item rows with kind pr_gate in a dedicated audit chat.
They record time, actor/chat, hostname, tool, gate id, outcome and submitted evidence.
Raw commands, HTTP headers and request bodies are omitted because they may hold secrets.
The Settings log shows the newest 100 events, expandable to read the evidence.
