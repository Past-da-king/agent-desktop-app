/**
 * A message sent while the agent is busy in the same chat. The person's rule: if it is about the same task it
 * joins the running work, with full context, and the agent may drop its old line of work and carry on; if it is
 * different work it runs separately and the person just gets a summary.
 *
 * Deciding, cheaply and locally (26 Oct 2026: his messages are never queued, so nothing slow sits in front of them):
 * a quick word check first (ported from HeuristicPolicy in reference/phone/Branching.kt): "ok thanks", "wait, I
 * meant...", "whoa, stop", "also..." are plainly about the running work. A message that names the running task, or
 * comes within a short window of his last one, is the same task by default. Only a message none of that settles may
 * go to an optional quick classifier (an API model, capped at a few seconds); with none, a later message that names
 * nothing of the task is different work. Missing, slow, failed or unsure: the message JOINS, because a missed stop
 * is the costly mistake.
 */
import type { BusyRoute } from '@agent/core'

export type Relation = 'ack' | 'supersede' | 'related' | 'unclear'

const ACK_WORDS = new Set([
  'ok', 'okay', 'k', 'kk', 'thanks', 'thank', 'you', 'thx', 'ty', 'cheers', 'cool', 'great', 'nice', 'perfect', 'got',
  'it', 'sure', 'yes', 'yep', 'yeah', 'yup', 'no', 'nope', 'good', 'awesome', 'sweet', 'lovely', 'fine', 'alright',
  'right', 'noted', 'np', 'ta', 'lol', 'haha', 'so', 'much', 'a', 'lot',
])
const SUPERSEDE_START =
  /^(wait|whoa|woah|hold on|hold up|hang on|stop|pause|actually|no wait|no no|no,|nope,|sorry|scrap that|forget (that|it)|never ?mind|ignore (that|the last|what)|disregard|cancel|i meant|i mean|correction|instead|change of plan|on second thought|not that|don'?t|do not|that'?s (wrong|not)|wrong|careful|hmm|eish|haibo)\b/i
const SUPERSEDE_ANYWHERE =
  /\b(i meant|i actually meant|scrap that|forget (that|it)|never ?mind|ignore (that|what i (said|asked))|disregard (that|what)|change of plan|instead of that|(wasn'?t|isn'?t|was not|is not|not) clear|misunderstood|not what i (meant|asked|said|want(ed)?)|that'?s (wrong|not (it|right|what))|stop (that|it|now|doing|everything)|don'?t (do|send|push|deploy) (that|it|anything)|do not (do|send|push|deploy))\b/i
const RELATED_START =
  /^(also|and also|and |plus|one more thing|oh and|while you'?re at it|additionally|btw|by the way|can you also|and then|on top of that|as well|make sure|don'?t forget|remember to|how'?s it going|how is it going|any progress|are you (done|nearly done|still)|status)\b/i

/** The quick word check. 'unclear' means it needs the classifier. */
export function heuristicRelation(text: string): Relation {
  const t = text.trim()
  const words = t
    .toLowerCase()
    .split(/[\s,.!?;:]+/)
    .filter((word) => word !== '')
  const noLetters = !/[\p{L}\p{N}]/u.test(t)
  if (t === '' || (noLetters && t.length <= 8) || (words.length >= 1 && words.length <= 4 && words.every((word) => ACK_WORDS.has(word)))) {
    return 'ack'
  }
  if (SUPERSEDE_START.test(t) || SUPERSEDE_ANYWHERE.test(t)) return 'supersede'
  if (RELATED_START.test(t)) return 'related'
  return 'unclear'
}

export type Verdict = 'same' | 'different' | 'unsure'

export interface RouteQuestion {
  /** What the person asked the running work to do (their last message before this one). */
  goal: string
  /** The new message. */
  text: string
  /** A few recent lines of the chat, newest last, for context. */
  recent: string[]
  /** True when the message carries files. */
  hasFiles?: boolean
  /** How long since his previous message in this chat. Absent: just now (inside the same-task window). */
  sinceLastMs?: number
}

/** A cheap model call answering same/different. Implementations must honour the signal. */
export type Classifier = (question: RouteQuestion, signal: AbortSignal) => Promise<Verdict>

export const CLASSIFIER_SYSTEM = [
  'You sort one message. An assistant is in the middle of a task for the user, and the user has just sent a new message in the same chat.',
  'Decide whether the new message is about the SAME task (it adds to it, corrects it, narrows it, changes the plan, asks how it is going, or replaces it with a closely related request) or is DIFFERENT, unrelated work that could be done separately at the same time.',
  'Reply with exactly one word: SAME, DIFFERENT or UNSURE.',
].join('\n')

export function classifierPrompt(question: RouteQuestion): string {
  const recent = question.recent.slice(-6).map((line) => `- ${clip(line, 300)}`)
  return [
    `The task being worked on: ${clip(question.goal, 800) || '(unknown)'}`,
    recent.length > 0 ? `Recent chat:\n${recent.join('\n')}` : '',
    `New message${question.hasFiles === true ? ' (with files attached)' : ''}: ${clip(question.text, 1500)}`,
    'SAME, DIFFERENT or UNSURE?',
  ]
    .filter((part) => part !== '')
    .join('\n\n')
}

/** The classifier's reply as a verdict. Anything that is not clearly one word is unsure. */
export function parseVerdict(reply: string): Verdict {
  const upper = reply.toUpperCase()
  const different = /\bDIFFERENT\b/.test(upper)
  const same = /\bSAME\b/.test(upper)
  if (different && !same) return 'different'
  if (same && !different) return 'same'
  return 'unsure'
}

export interface RouteDecision {
  route: BusyRoute
  /**
   * Why, in a few words, for the log and tests: 'words', 'mentions', 'classifier', 'unsure', 'timeout',
   * 'no-classifier', 'error', 'local'.
   */
  why: string
  relation: Relation
}

/**
 * A second message this soon after his last one is about the same task unless something clearly says otherwise
 * (his rule, 26 Oct 2026: within a short window, or mentioning the running task, it is the same task by default).
 */
export const SAME_TASK_WINDOW_MS = 120_000

/**
 * The classifier is optional and must be quick: it only ever runs for a message the words and the window could not
 * settle, and never longer than this. Too slow, failed or unsure: the message joins (a missed stop is the costly
 * mistake), so his message is never held back for long.
 */
export const CLASSIFY_TIMEOUT_MS = 2_500

const STOP_WORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'what', 'when', 'where', 'which', 'will', 'would', 'could',
  'should', 'there', 'their', 'them', 'they', 'then', 'than', 'your', 'about', 'into', 'just', 'like', 'make', 'some',
  'want', 'need', 'please', 'also', 'more', 'only', 'very', 'been', 'were', 'does', 'done', 'doing', 'thing', 'things',
  'today', 'tomorrow', 'know', 'think', 'look', 'find', 'give', 'take', 'tell', 'send', 'check',
])

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 4 && !STOP_WORDS.has(word))
      .map((word) => word.replace(/(ing|ed|es|s)$/, '')),
  )
}

/** Does the new message name something the running task is about (a word that matters, in both)? */
export function mentionsTask(goal: string, text: string): boolean {
  const task = contentWords(goal)
  if (task.size === 0) return false
  for (const word of contentWords(text)) if (word.length >= 3 && task.has(word)) return true
  return false
}

/** The cheap local call, no model: same, different, or unsure (inside the window with nothing else to go on). */
export function localVerdict(question: RouteQuestion): { verdict: Verdict; why: string; relation: Relation } {
  const relation = heuristicRelation(question.text)
  if (relation !== 'unclear') return { verdict: 'same', why: 'words', relation }
  if (question.text.trim() === '') return { verdict: 'same', why: 'words', relation }
  if (mentionsTask(question.goal, question.text)) return { verdict: 'same', why: 'mentions', relation }
  const since = question.sinceLastMs ?? 0
  if (since <= SAME_TASK_WINDOW_MS) return { verdict: 'unsure', why: 'window', relation }
  const words = question.text.trim().split(/\s+/).length
  return words >= 4 ? { verdict: 'different', why: 'local', relation } : { verdict: 'same', why: 'local', relation }
}

/**
 * Same task joins; different work goes alongside; anything uncertain joins. Never throws, and never waits on a model
 * longer than `timeoutMs` (the words and the window settle most messages with no model at all).
 */
export async function decideRoute(
  question: RouteQuestion,
  classifier: Classifier | null,
  timeoutMs = CLASSIFY_TIMEOUT_MS,
): Promise<RouteDecision> {
  const local = localVerdict(question)
  const relation = local.relation
  if (local.verdict === 'same') return { route: 'join', why: local.why, relation }
  if (classifier === null) {
    return local.verdict === 'different' ? { route: 'alongside', why: 'local', relation } : { route: 'join', why: 'no-classifier', relation }
  }

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('timeout')
    }, timeoutMs)
  })
  try {
    const verdict = await Promise.race([classifier(question, controller.signal), timeout])
    if (verdict === 'timeout') {
      return local.verdict === 'different' ? { route: 'alongside', why: 'local', relation } : { route: 'join', why: 'timeout', relation }
    }
    if (verdict === 'different') return { route: 'alongside', why: 'classifier', relation }
    return { route: 'join', why: verdict === 'same' ? 'classifier' : 'unsure', relation }
  } catch {
    return { route: 'join', why: 'error', relation }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The note a joined message becomes inside the running work. */
export function joinNote(text: string): string {
  return [
    '[The user sent this while you were working. It is about the task you are on, so take it in now. If it changes or replaces what you were doing, drop the old plan and carry on with what they want now; otherwise fold it into the work. Answer it as part of this task.]',
    text,
  ].join('\n')
}

/** The brief of a separate run started for a different job sent while the chat was busy. */
export function alongsideBrief(text: string, goal: string): string {
  return [
    `[The user sent this message in a chat where you were already busy with another task ("${clip(goal, 200) || 'an earlier request'}"). It is different work, so you are doing it separately, at the same time, as its own run. Do it fully. Do not touch the other task.]`,
    '[Your final message is shown to the user as a short summary of what you did. Write it to them, plainly, in a few lines, with the result first.]',
    '',
    text,
  ].join('\n')
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}...`
}
