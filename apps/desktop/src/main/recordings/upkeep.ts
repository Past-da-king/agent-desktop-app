/**
 * Recordings upkeep, a little after start and then every night: finish what the last run left unfinished
 * (recordings/store.ts `recover`), tell him once about each recovered recording, and delete audio the keep
 * setting no longer keeps. Never blocks startup and never throws.
 */
import { BYTES_PER_SECOND, SOURCE_LABELS, type AudioKeep, type RecoveredNotice, type Recordings, type Transcribe } from './store'

export interface UpkeepDeps {
  recordings: Pick<Recordings, 'recover' | 'cleanup'>
  keep: () => AudioKeep
  /** The app's own transcription (the dictation fallback); null while there is no voice key. */
  transcribe: () => Transcribe | null
  notify: (notice: RecoveredNotice) => Promise<void>
  log?: (message: string, fields?: Record<string, string | number | boolean>) => void
  /** How long after start the first pass runs. Default 3 s. */
  delayMs?: number
  now?: () => number
}

export interface Upkeep {
  /** The first pass, words and notices included. */
  done: Promise<void>
  stop(): void
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`
}

/** The quiet line in the chat about one recovered recording. */
export function recoveredNoticeText(notice: RecoveredNotice): string {
  const at = new Date(notice.startedAt)
  const when = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  const what = notice.source === 'call' ? 'call' : 'recording'
  const head = `An unfinished ${what} from ${when} (${clock(notice.durationMs)}, ${SOURCE_LABELS[notice.source] ?? notice.source}) was saved after the app closed.`
  const words = notice.text.trim()
  if (words === '') return `${head} Its words could not be had yet; the audio is kept. Ask the agent for it any time.`
  const shown = words.length > 600 ? `${words.slice(0, 597)}...` : words
  return `${head} Its words: "${shown}"`
}

/** Milliseconds from `now` to one minute past the next local midnight. */
export function untilNextNight(now: number): number {
  const next = new Date(now)
  next.setHours(24, 1, 0, 0)
  return Math.max(60_000, next.getTime() - now)
}

export function startRecordingsUpkeep(deps: UpkeepDeps): Upkeep {
  const log = deps.log ?? (() => undefined)
  const now = deps.now ?? Date.now
  let stopped = false
  let night: ReturnType<typeof setTimeout> | null = null

  const cleanup = async (): Promise<void> => {
    try {
      await deps.recordings.cleanup(deps.keep())
    } catch (error) {
      log('Recordings cleanup failed', { reason: error instanceof Error ? error.message : 'unknown' })
    }
  }

  const armNight = (): void => {
    if (stopped) return
    night = setTimeout(() => {
      void cleanup().then(armNight)
    }, untilNextNight(now()))
    night.unref?.()
  }

  const done = new Promise<void>((resolve) => {
    const first = setTimeout(() => {
      void (async () => {
        try {
          const transcribe = deps.transcribe()
          const { recovered, words } = await deps.recordings.recover({
            ...(transcribe === null ? {} : { transcribe }),
            timeoutMs: (bytes) => Math.min(90_000, Math.round(30_000 + (bytes / BYTES_PER_SECOND) * 500)),
            notify: deps.notify,
          })
          if (recovered.length > 0) log('Recordings recovered after a restart', { count: recovered.length })
          await words
        } catch (error) {
          log('Recordings recovery failed', { reason: error instanceof Error ? error.message : 'unknown' })
        }
        await cleanup()
        armNight()
        resolve()
      })()
    }, deps.delayMs ?? 3000)
    first.unref?.()
  })

  return {
    done,
    stop: () => {
      stopped = true
      if (night !== null) clearTimeout(night)
    },
  }
}
