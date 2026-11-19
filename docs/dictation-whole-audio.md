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

## Phone RPC contract (final, 19 Nov 2026, desktop 0.2.137; phone 0.15.75 and later)

### 1. `voice.transcribe(audio, extra?)` (piece or whole take)
    voice.transcribe([ {"$b64": <PCM16 16 kHz mono>}, {"whole": true, "names": [...], "languages": ["en-ZA","zu-ZA",...]} ])
- With the second argument (`whole: true`, 0.15.75): the audio is the entire take, ONE pass (inline up to 12 MB of wav,
  Files API above). `names` (max 100, 60 chars each) go in FRONT of the computer's memory names; `languages` (max 6) in front
  of the computer's own, duplicates dropped, 6 sent. Up to 10 minutes.
- Without it (0.15.74 phones): a piece, answered by its own pass, unchanged; the pieces cannot be joined here (no take id).
- Reply `{ok: true, text}` or `{ok: false, error}`. The text is spelled by the computer's name fixes (`respellNames`).

### 2. Instant send (the phone never waits)
1. Phone: `chat.send` (or `chat.sendOnce`) with the live caption as `text` and options
   `{"dictation": {"id": "<recording id>", "pending": true, "caption": "<live text>"}}`. The row is in the chat at once
   with `meta.dictation = {id, pending: true}` (draw a "Refining" mark). The agent's turn does NOT start.
2. Phone: `voice.takeAudio({"id": "<same id>", "audio": {"$b64": <whole take>}, "chat": "<chat>", "caption": "...",
   "names": [...], "languages": [...]})` in the background (retry from an on-disk queue until it answers `ok`).
   Answer `{ok: true, state: "queued"|"running"|"done"|"failed", duplicate?: bool}`. Idempotent by `id`: the same id again
   never runs a second pass, except a take whose state is `failed`, which a resend runs again.
3. Computer: stores the take on disk (`voice-notes/pending-takes/<id>.json` + `.pcm`), runs the ONE pass, replaces the row
   in place (`text` = clean text, `meta.dictation = {id, pending: false, final: true}`) and only then starts the agent's
   turn with the clean text. The wait is capped at 30 s + 0.5 s per second of audio (max 100 s); the cap starts when the audio
   is here, and at most 100 s if the audio never comes.
4. Failure or timeout: the agent gets the caption plus the line "dictated; clean transcript failed, this is the live caption";
   the row becomes `meta.dictation = {id, pending: false, failed: true}` (draw "Sent as heard" and Retry).
5. Retry: `voice.takeAudio({"id": "<id>", "retry": true})` (no audio) runs the kept audio again; success replaces the row
   in place (the agent already read the caption).
6. Restart: the computer resumes every queued or running take at start; nothing runs or replaces twice.

### 3. Desktop (same machinery)
The message-box mic and the Ctrl+/ shortcut: Send during a dictation ends the mic at once and calls `chat.send` with
`{"dictation": {"handOff": true}}`; main takes the audio and the preview words and does steps 1 to 4 itself.

### Known gaps
A project chat placed on another computer is not forwarded as a dictated message. A take still queued when the app is
closed is written down and its row replaced at the next start, but the agent turn that waited for it is not re-run.

## Model setting (Settings > Voice and dictation > Dictation model, `dictationModel`)
Default `gemini-3.1-flash-lite`. A `*transcribe*` model uses the Interactions request (custom vocabulary, language codes); any
other model reads the same file with the prompt (names for spelling, "write exactly what was said, each word in the language
said, never translate"). If the chosen general model fails (quota, busy), the speech model gets the same audio.
Measured 19 Nov 2026, 3 runs each, names list in every request (clips: a 47 s Gemini TTS stand-in of his real wording with
his names and isiZulu, the 12 Nov zuen clip, and his real 111 s take 20261119-212407-99e6 pieces; his real recordings with
isiZulu had been cleaned up already):

| model | about cents/min | isiZulu kept (3 runs of zuen) | names right (tts, 11 names) | real take |
|---|---|---|---|---|
| gemini-3.5-transcribe | 0.54 | DROPPED ALL isiZulu in 1 of 3 runs (208 chars) | 11, 10, 10 | "corrected" his quoted "started edge" to "Strat Edge"; 429 on run 3 |
| gemini-3.1-flash-lite | 0.11 | 3 of 3 | 10, 10, 10 | his words as said, 2 s |
| gemini-3.5-flash-lite | 0.10 | 3 of 3 | 6, 8, 8 ("StratEdge", "MacQuarie") | ok |
| gemini-3.6-flash | 0.8 | 2 of 2 (429 on the third) | 10, 10, 10 | ok, 5 to 17 s |

## The headless node (agent-node), 20 Nov 2026

A phone linked to agent-node (not to the computer's app) gets the same instant send. The wiring is shared code, not a copy:
`main/dictation/instant.ts` (queue, runner hold, `voice.takeAudio`, resume at start) and `main/dictation/take-batch.ts`
(the one whole-audio pass with the phone's names and languages merged in front of memory's). `main/index.ts` and
`headless/runtime.ts` both call them. The node has no microphone, so `chat.send` `dictation.handOff` never applies there.
Proof: `apps/desktop/test/headless-instant-send.test.ts`.
