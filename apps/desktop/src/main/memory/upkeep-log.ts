/**
 * The memory upkeep file (memory-upkeep.json under userData): when the daily pass last ran, the earlier "Where we
 * are" pages, the last report, and a log of every change the upkeep made with the page as it was before, so each
 * change can be undone. Nothing the upkeep drops is lost: the old row is in this log.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { UpkeepChange, UpkeepReport } from '@agent/core'

export type { UpkeepChange, UpkeepReport }

export interface UpkeepState {
  /** The last local day (YYYY-MM-DD) the daily pass ran for. */
  lastDay: string
  lastRunAt: number
  history: Array<{ day: string; body: string }>
  report: UpkeepReport | null
  log: UpkeepChange[]
}

const EMPTY: UpkeepState = { lastDay: '', lastRunAt: 0, history: [], report: null, log: [] }
const MAX_LOG = 600
const MAX_HISTORY = 60

export class UpkeepFile {
  constructor(private readonly file: string | null) {}

  private memory: UpkeepState = structuredClone(EMPTY)

  read(): UpkeepState {
    if (this.file === null) return structuredClone(this.memory)
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return structuredClone(EMPTY)
      return { ...structuredClone(EMPTY), ...(parsed as Partial<UpkeepState>) }
    } catch {
      return structuredClone(EMPTY)
    }
  }

  write(state: UpkeepState): void {
    const trimmed: UpkeepState = {
      ...state,
      log: state.log.slice(-MAX_LOG),
      history: state.history.slice(-MAX_HISTORY),
    }
    if (this.file === null) {
      this.memory = structuredClone(trimmed)
      return
    }
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(trimmed), { mode: 0o600 })
    renameSync(temp, this.file)
  }

  update(change: (state: UpkeepState) => void): UpkeepState {
    const state = this.read()
    change(state)
    this.write(state)
    return state
  }
}
