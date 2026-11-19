# Dictation: one pass over the whole audio (19 Nov 2026)

## Rule
The take is recorded as plain audio. ONE Gemini request reads the WHOLE audio; that text is the message. The live caption
is only a preview. Applies to the message-box mic, the Ctrl+/ shortcut and a linked phone's `voice.transcribe`.

## Desktop
- `dictation/whole.ts` `transcribeWhole`: one request however long. `voice/gemini.ts` sends it inline up to 12 MB of wav
  (about 6 min), above that uploads it once (Files API) and sends one request by file uri. Only if the whole pass fails
  twice (and the take is over 2 min) is it cut at quiet moments, and that is logged.
- Names and languages go into that one request: `custom_vocabulary` (up to 100, from memory: pinned pages, people,
  organisations and projects first, then by how many pages link to them, then newest) and `language_codes` (system
  languages plus the neighbours of EVERY region found, max 6). The fallback general model is told to write exactly what was
  said, each word in the language said, never translate, with the names for spelling.
- `dictation/respell.ts` `respellInContext`: multi-word names said wrong in the first word ("started edge", "strata edge",
  "strat-ed edge", "that edge") are put right by sound when a company word is next to them. Left alone: talk about the
  mistake (said, saying, instead, spelled, called, supposed...), a sentence that already has the name right, and a plain
  "that edge" with nothing company-like near. Runs on the final text AND on the live preview (`previewFix`).
- Limits: `TRANSCRIBE_MAX_MS` 150 s, take cap 10 min, finish limit 150 s.

## Phone RPC contract (agreed with "Phone whole-audio pass")
- `voice.transcribe(pcm16k)`: ONE call carrying the WHOLE take; answered by ONE pass. Up to 10 min.
- 0.15.74 phones send pieces of the take (no take id): each piece is still answered by its own pass, unchanged. The
  protocol has no marker to join pieces on this side, so a phone that wants one pass must send the whole take.
- Instant send (design of 19 Nov 21:30): the phone sends the message with the live caption at once, then
  `dictation.take { id (recording id), chat, live, audio }`. `dictation/pending.ts` `PendingTakes.accept` writes it to disk
  (`<dir>/<id>.json` + `.pcm`) and answers at once; the pass replaces the message in place (`replace`), `settled(id)` is
  what the agent's turn waits for (cap 30 s + 0.5 s per second said, max 100 s; then the caption plus the note "dictated;
  clean transcript failed, this is the live caption"). `retry(id)`, `resume()` at start, idempotent by id.
  NOT yet wired to the chat runner, the RPC table or the renderer (see PR description).
