/**
 * recordings_list and recordings_get: the person's own recordings and dictations, kept on disk as they happen
 * (recordings/store.ts). Read-only. They answer "find the recording I was making" after a crash or a restart.
 */
import { int, schema, str, type Tool } from '@agent/core'

import type { RecordingDetail, RecordingSummary } from '../recordings/store'

export interface RecordingsReader {
  list(query: { since?: number; query?: string; limit?: number }): Promise<RecordingSummary[]>
  get(id: string): Promise<RecordingDetail | null>
}

/** "2026-10-26", "2026-10-26T14:00", "today", "yesterday" or a number of hours ("3h"), as epoch ms. */
export function parseSince(raw: string, now: number = Date.now()): number | null {
  const value = raw.trim().toLowerCase()
  if (value === '') return null
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  if (value === 'today') return start.getTime()
  if (value === 'yesterday') return start.getTime() - 86_400_000
  const hours = /^(\d+(?:\.\d+)?)\s*h(?:ours?)?$/.exec(value)
  if (hours !== null) return now - Number(hours[1]) * 3_600_000
  const minutes = /^(\d+)\s*m(?:in(?:utes?)?)?$/.exec(value)
  if (minutes !== null) return now - Number(minutes[1]) * 60_000
  // A bare date or date-time is local time, like everything else he says.
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2}))?$/.exec(value)
  if (date !== null) {
    return new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]), Number(date[4] ?? 0), Number(date[5] ?? 0)).getTime()
  }
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function line(item: RecordingSummary): string {
  const audio = item.audioExists ? `audio ${item.audioPath}` : 'audio deleted (transcript kept)'
  const words = item.preview === '' ? '(no words yet)' : `"${item.preview}"`
  const chat = item.chat === null ? '' : ` chat ${item.chat};`
  return `- ${item.id}: ${item.time}, ${item.durationSeconds} s, ${item.source}, ${item.status}; words ${item.transcriptState} (${item.transcriptChars} chars);${chat} ${audio}\n  ${words}`
}

export function recordingsTools(reader: RecordingsReader, now: () => number = Date.now): Tool[] {
  return [
    {
      spec: {
        name: 'recordings_list',
        description:
          "The person's recent recordings and dictations (message box mic, dictation shortcut, calls, a linked device's mic), newest first: when, how long, where from, status (finished, recovered after a crash or restart, unfinished, recording), whether the audio still exists and where, and the start of the transcript. Every recording is written to disk as it happens, so use this for 'find the recording I was making' or 'what did I dictate earlier'. recordings_get gives one transcript in full.",
        schema: schema([], {
          since: str("Only from this time on: 'today', 'yesterday', '3h', '2026-10-26' or '2026-10-26 14:00' (local time)"),
          query: str('Only recordings whose words contain all of these words'),
          limit: int('How many, default 10, at most 100'),
        }),
      },
      run: async (input) => {
        const sinceRaw = typeof input['since'] === 'string' ? input['since'] : ''
        const since = sinceRaw === '' ? null : parseSince(sinceRaw, now())
        if (sinceRaw !== '' && since === null) return `Could not read "${sinceRaw}" as a time. Use 'today', '3h' or '2026-10-26 14:00'.`
        const query = typeof input['query'] === 'string' ? input['query'] : ''
        const limit = typeof input['limit'] === 'number' ? input['limit'] : 10
        const items = await reader.list({ ...(since === null ? {} : { since }), ...(query === '' ? {} : { query }), limit })
        if (items.length === 0) return query === '' && since === null ? 'No recordings are kept on this computer yet.' : 'No recordings match.'
        return `${items.length} recording${items.length === 1 ? '' : 's'} (audio is kept until the end of its day by default; transcripts are kept):\n${items.map(line).join('\n')}`
      },
    },
    {
      spec: {
        name: 'recordings_get',
        description: "One recording by its id from recordings_list: the full transcript, its state, the audio file's path if it still exists, and the folder it lives in.",
        schema: schema(['id'], { id: str('The recording id, e.g. 20261026-145230-ab12') }),
      },
      run: async (input) => {
        const id = typeof input['id'] === 'string' ? input['id'].trim() : ''
        if (id === '') return 'Give the recording id from recordings_list.'
        const item = await reader.get(id)
        if (item === null) return `No recording ${id}.`
        const lines = [
          `${item.id}: ${item.time}, ${item.durationSeconds} s, ${item.source}, ${item.status}`,
          `Words: ${item.transcriptState}${item.transcriptError === undefined ? '' : ` (${item.transcriptError})`}`,
          `Audio: ${item.audioExists ? item.audioPath : 'deleted (transcript kept)'}`,
          `Transcript file: ${item.transcriptPath}`,
          ...(item.chat === null ? [] : [`Chat: ${item.chat}`]),
          '',
          item.transcript === '' ? '(no words yet)' : item.transcript,
        ]
        if (item.liveTranscript !== undefined && item.liveTranscript.trim() !== '') lines.push('', `What the live words had said: ${item.liveTranscript}`)
        return lines.join('\n')
      },
    },
  ]
}
