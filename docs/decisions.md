# Decisions (fast yes/no, choice and score answers)

An optional capability. A decision model writes no text: it reads an input and answers named questions with a probability and a confidence in a few hundred milliseconds, for a tiny fraction of an LLM call. The app uses it as a cheap pre-check. It only skips or routes when it is confident. In every other case the normal path runs unchanged.

Off by default. Nothing here is tied to one person's setup: no keys in the code, model ids are defaults only, every backend is optional.

## Turn it on

Settings, Agents and helpers:

| Setting | Key | Default | Meaning |
| --- | --- | --- | --- |
| Fast decisions | `decisionsEnabled` | off | The master switch. Off means no read, no network call. |
| Decision model | `decisionsBackend` | `gemini` | `gemini`, `jev`, `openai` or `llm` (the app's own model). |
| How sure before it acts | `decisionsThreshold` | 0.9 | 0.5 to 0.99. An answer counts only at or above this confidence. |

`settings_get` shows them. `settings_set` on any of the three asks the person first (they decide where text goes and what may be skipped).

## Keys: nothing new is asked

- Gemini: the Gemini key the app already holds (Settings, Voice), else a Gemini AI account's key.
- OpenAI: the secret `decisionsKey-openai`, else an OpenAI API account's key.
- Jev: the secret `decisionsKey-jev` (an OpenRouter key), else an OpenRouter API account's key.

No key means the normal path. The key is read on each call and never logged.

## What happens on each call (decisions/service.ts)

1. Off: return at once. No network, path `none`, reason `off`.
2. Ask the chosen backend with a 5 second limit.
3. Per question: confident when its confidence is at least the threshold.
4. On an error, a timeout, a rate limit, no key, or a question below the threshold: with `fallback: 'llm'` the app's own model answers just those questions (path `decision+llm` or `llm`). With `fallback: 'none'` the caller does its normal work (path `none` or `decision` with `allConfident: false`).
5. Every call logs one line: path, provider, reason, number of questions, latency.

Confidence is `max(p, 1 - p)`. It is how sure the model is of its own top answer, not how often it is right. A vague question returns about 0.57. Write one clear question each. The eval harness below measures how often "confident" is right for your own questions.

## Backends (decisions/providers/)

| Backend | Endpoint and shape | Source | Tested |
| --- | --- | --- | --- |
| gemini | `POST https://generativelanguage.googleapis.com/v1beta/decisions`, `x-goog-api-key`, `{model: 'gemini-decision-1', input, questions: {id: {type: noul/choice/score, instructions, criteria}}}`, answers keyed by id | aistudio.google.com/docs/decisions-api | mocked HTTP |
| jev | OpenRouter alpha: `POST https://openrouter.ai/api/alpha/decisions`, bearer key, `{model: 'typesafe/jev-1.14', state, questions}`, answers keyed by id. Same envelope on AI/ML API and Eden AI, so the address is overridable | openrouter.ai/docs/api/api-reference/alphadecisions | mocked HTTP; the noul field name is read leniently (`noul`, `probability` or `value`) |
| openai | `POST https://api.openai.com/v1/decisions`, bearer key, `{model: 'gpt-6-luna', input, questions: [{type: predicate/choice/score, name, instructions, choices/levels}]}`, answers as an ordered array, 1 to 400 questions | developers.openai.com/api/reference/resources/decisions | mocked HTTP |
| llm | The app's own model, one JSON reply (`Runner.oneShot`) | none | mocked |

Gemini: 1 to 1,000 questions, 262k tokens, images accepted, only input tokens billed (US$0.10 per 1M). Free tier keys may use your data for training: for real private mail use a paid-tier key.

## The `decide` tool

Any agent, desk or routine can call it. Input text, a list of questions (`id`, `type`, `instructions`, `options` for a choice, `levels` for a score), optional `threshold` and `fallback`. It returns the path, provider, latency and, per question, the value, probabilities, confidence and whether it is confident. Off: it says so and the agent answers itself. In core code use `DecisionService.decide(input, questions, options)`.

## Where it plugs in now (ranked list, v1 wiring marked)

1. **Desk triage (built).** `EventRouter` asks "does this event need the desk?" for each gathered event before the desk runs. A confident "no" marks the event `ignored` with the reason (visible on the Workers page); everything else goes to the desk as before. If every event is noise the desk does not run. Never uses the LLM fallback.
2. **Routine delta check (built).** A routine created with `delta_check: true` (interval or daily) is skipped when the pre-check is confident nothing new reached the app (worker events since its last run). A skipped run says nothing and its last result reads "Skipped: ...". Routines that do not opt in always run. The pre-check can only see worker events today, so use it for routines that react to worker events.

Planned, not built:

3. **wake_me severity and approval needed (b).** Before a wake rings, ask "is a person waiting right now?" and "is this a deadline today?" to suggest the severity, and "does this need his approval?" before an approval card. Only ever lowers noise: a wake is never suppressed by a decision.
4. **Phone background screen state (d).** On a screenshot: loaded? captcha? login wall? error page? Cuts a vision-model call per step. Image input is supported by the Gemini backend.
5. **Routing a message to a project or profile (e).** One `choice` question with the project names as options and a catch-all. Below the threshold, the main agent routes it.
6. **Inbox lead qualification (f).** A set of noul questions per lead (does it handle enquiries by WhatsApp, is it a booking business, has it a named contact) scored in one call.
7. **More delta sources (c, extended).** Mail and calendar change feeds, so interval routines that poll connected apps can skip too.

Not for decisions: anything that cannot be undone on its own, anything that needs reasoning or writing, and questions with no clear yes or no.

## Eval harness

```
GEMINI_API_KEY=... node scripts/decisions-eval.mjs --data apps/desktop/test/fixtures/decisions/seed.jsonl --backend gemini --target 0.95
```

Options: `--backend gemini|jev|openai`, `--model`, `--url`, `--concurrency 4`, `--limit N`, `--json out.json`, `--simulate` (a local stand-in that checks the harness, the numbers mean nothing). The key comes only from the environment (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `JEV_API_KEY`).

Example file: JSON Lines, one example per line:

```
{"id":"a1","input":"text","questions":{"urgent":{"type":"noul","instructions":"..."}},"expected":{"urgent":true}}
```

`expected` is `true`/`false` for a noul, the option id for a choice, the level index (0 first) for a score. Only labelled questions are asked. The seed set `apps/desktop/test/fixtures/decisions/seed.jsonl` is 51 synthetic mails and chat lines (needs_attention, urgent, route). Never put real mail in the repo: write your own file elsewhere and pass `--data`.

`--observations file.json` summarizes a run made elsewhere (a machine the key is allowed on). Output: per-question accuracy, calibration by confidence bucket (how often right at each confidence), the coverage and accuracy at each threshold, latency (p50, p95), and the lowest threshold whose answers reach the target accuracy (default 95%, at least 10 answers). Set `decisionsThreshold` to that value (or higher for anything costly to skip), rounded up to the nearest option, and re-run when the questions change. It also prints the recommendation per question.

## Live eval: gemini-decision-1 (13 Nov 2026)

Seed set: 51 synthetic mails and chat lines, 3 questions each (153 answers): `needs_attention` (yes/no, the desk question), `urgent` (yes/no) and `route` (a choice of 5 teams). Run with the Vault key, 51 requests, 4 at a time, no failed requests, 20,987 input tokens in total (about US$0.002). The key is refused from the impetix server's address (403 on every call, even the model list), so the calls were made from the PC; the raw observations are in `docs/decisions-eval-live-2026-11-13.observations.json` and the report below comes from `node scripts/decisions-eval.mjs --observations <file>`.

| Question | Answers | Accuracy |
| --- | --- | --- |
| needs_attention | 51 | 94.1% |
| urgent | 51 | 94.1% |
| route (5 teams) | 51 | 82.4% |
| all | 153 | 90.2% |

Calibration (confidence bucket, how often right):

| Confidence | Answers | Right |
| --- | --- | --- |
| under 0.50 (choices only) | 2 | 0.0% |
| 0.50 to 0.60 | 13 | 61.5% |
| 0.60 to 0.70 | 9 | 77.8% |
| 0.70 to 0.80 | 12 | 83.3% |
| 0.80 to 0.90 | 17 | 76.5% |
| 0.90 to 0.95 | 20 | 100% |
| 0.95 to 1.00 | 80 | 100% |

Calibration error 0.050. Every answer at 0.9 or higher was right (100 of 100); every wrong answer had a confidence of 0.85 or lower.

| Threshold | Share of answers it lets through | Accuracy of those |
| --- | --- | --- |
| 0.70 | 84.3% | 95.3% |
| 0.80 | 76.5% | 96.6% |
| 0.90 | 65.4% | 100% |
| 0.95 | 52.3% | 100% |
| 0.99 | 20.9% | 100% |

Recommended threshold: the harness picks the lowest bar that reaches 95% (0.70, with 95.3%, which is marginal). Skipping work is the costly mistake, so the shipped default is **0.9**. On the desk question the three wrong answers were all "yes" for a message that was noise (a lunch note, an automated dependency bump, a cold pitch), which only costs a desk run. There was no wrong "no", so nothing needed was skipped.

Latency per request from a browser in South Africa: p50 859 ms, p95 1,424 ms (this includes the round trip to Google and 4 calls at once; the median measured from the server was 285 ms for one question and 437 ms for 20).

The seed set is small and synthetic: treat these as a floor check, not a promise. Re-run the harness on a file of your own labelled examples before relying on a lower bar. For real private mail use a paid-tier Gemini key: free-tier keys may use your data for training.

## Tests

`apps/desktop/test/decisions-*.test.ts`: each adapter with mocked HTTP, the fallback rules, the threshold, toggle off means no network call, key reuse, the desk pre-check through a real `EventRouter`, the routine pre-check through a real `Scheduler`, the eval harness, the tool and the settings.
