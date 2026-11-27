# Voice notes and headless tool parity

25 November 2026. The node already constructed `VoiceService`, saved WAV notes and registered `voice.noteAudio`. Its toolset composition omitted `voiceNotes`. Separately, `buildToolset` offered the tool only to main agents. Both omissions are fixed: the common worker toolset owns voice_note and both desktop and node supply the same service lazily. Notes carry the calling chat in metadata.

`VoiceService` reads only `geminiKey` from the app secrets store. The existing encrypted device bundle carries that setting to linked nodes. There is no embedded key, separate account, provider default key or new approval bypass. A missing key returns the existing Settings instruction without a provider request or chat row. The output remains a voice_note chat row with WAV filename, duration and style. Existing row replication and voice.noteAudio RPC serve it to the phone, whose RemoteSession downloads that RPC audio and renders its voice bubble.

## Desktop main versus headless main

| Tool | Before | Outcome |
| --- | --- | --- |
| voice_note | Missing voiceNotes dependency | Fixed; same VoiceService and key store, main and helpers. |
| show_media | Missing media dependency and token fetch registration | Fixed; persisted ShownMedia allow-list and existing bounded media.fetch route. Main and helpers. |
| screen_guide | Requires the person's desktop windows and guide overlay | Intentionally absent on a server. |
| screen_windows, screen_read, screen_act | Windows desktop control service absent | Intentionally absent; no server screen or input substituted. |
| app_update | Windows signed-installer updater absent | Intentionally absent; Linux node deployment is a separate explicit operation. |

All remaining shared tool names are present. A listed tool can still require an appropriate host capability: miniapp_* are already offered on the node but their Electron offscreen look checker and window opener are absent. They remain unavailable locally rather than falsely claiming a look check. The node's existing devices argument routes opening to the person's device. files_pick uses its existing remote picker; headless browser tools depend on installed Chromium; agent_desktop keeps its existing platform refusal. app_action exposes only the headless handler registry. None of these is a newly missing tool name or a permission expansion.

## Desktop main versus helpers

| Tool or group | Outcome |
| --- | --- |
| voice_note | Fixed on desktop and node helpers. |
| show_media | Fixed on desktop and node helpers. |
| chats_search, chat_read | Remain main-only: the current chat-history tools search all past chats without project/profile scoping. Extending that access to project helpers needs a separate scoped design. |
| git_status_report, git_autocommit_log | Node helpers now get the existing git service, matching desktop helpers. |
| delegate, helper_steer, helper_push, helpers_status, helper_stop, profile_create | Remain main-only orchestration; helpers cannot recursively spawn helpers. |
| project_list, project_create, project_update, project_chat_start, project_chat_send, message_main, project_open | Existing main/project orchestration boundary retained. |
| open_url, send_file | Existing main-only device delivery boundary retained. |
| app_update, meeting_ended, cards_waiting, card_answer | Existing main-only install, presence and approval authority retained. |

## Regression proof

`test/headless-voice-note.test.ts` boots the real headless runtime without a key, checks main and helper catalogues, calls the shared TTS service against fake provider responses, checks playable RIFF bytes, missing-key behavior, calling-chat metadata and database replication, and invokes the same audio IPC handler used by the phone RPC. No live account or provider key is used. The extra parity test initially failed because show_media was missing. The initial voice tests failed in four places on the original source.

Live desktop and agent-node installations are deliberately outside this change. Release artifacts must be proven and installed separately.

## Playback after another computer answered

The second gap was independent of tool discovery: chat replication copies the row, not the WAV file. A phone or desktop connected to a different brain therefore asked the wrong local voice folder. New notes name their producing device in audioDevice. The shared voice.noteAudio handler now reads locally first, then retrieves a replicated note from its still-trusted paired producer over the existing TLS-pinned authenticated RPC. A local-only argument prevents relay loops. Old notes without provenance can be looked up among paired brains. Unknown filenames, invalid paths, disabled Devices and revoked peers never authorize a remote read; revocation and endpoint identity are checked again after the reply. No audio is embedded in chat rows and no third-party store is used. The pairing pass is the same pass replication uses, including on newly joined nodes.

The peer-audio regressions first failed because the module did not exist, then passed. A two-process built-node proof paired isolated nodes, replicated a note, fetched its exact WAV through the reader node, revoked the producer and confirmed the reader then returned null. All test processes were stopped. Neither live service was used for the mesh proof.

## When a key runs out of allowance (27 November 2026)

Google's free speech allowance is ten calls a day for each speech model of each key. One exhausted key took every voice note down until midnight in California, although the Vault already held backup keys made for exactly that. A voice note now walks an ordered list: the voice key in Settings (`geminiKey`), then every Vault item named `Gemini API key: A.O.S voice-note backup ...`, in Vault order.

- A key that answers 429 or RESOURCE_EXHAUSTED rests until its allowance is back: the next midnight in Pacific time for a daily quota, and a minute (or the provider's own "retry in", capped at ten minutes) for a per-minute one.
- The same script goes to the next key. Each speech model keeps its own turn as before, so a model out of quota still hands over to the next model of the same key.
- Only when every key is resting does the note fail, with one plain line instead of a per-key error.
- Keys are read at runtime from the key store and the Vault on every call, so a key added to the Vault works for the next note with no restart. `voice/keyring.ts` remembers a fingerprint of each resting key and nothing else: no key goes into settings, chat, logs or a request body.
- A refused key (400, 401, 403) does not fall through to a backup; that refusal is the answer, so a wrong key is never hidden behind a working one.
- Still on the voice key alone: Live call tokens (`mintLiveToken`), the Files API upload used for dictations too long to send inline, and dictation chunking. Everything that goes through `post()` rotates keys already.
- Tests: `apps/desktop/test/voice-key-fallback.test.ts`. They fail on the source before this change (7 of 14) and on mutation controls that stop asking the backups, stop remembering a resting key, or give a key no rest at all.
