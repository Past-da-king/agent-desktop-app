/**
 * Settings > This computer: how much work runs at once. Every limit is off unless the person sets one
 * (rule of 23 Oct 2026: "I want to run as many as I want"). Blank or 0 = no limit.
 */
import type { Settings } from '@agent/core'
import { useEffect, useState } from 'react'

import { useSettings } from '../state/useSettings'
import { toast } from '../state/useToast'
import { Icon, type IconName } from '../ui/Icon'

type LimitKey = 'helpersAtOnce' | 'helperMaxSteps' | 'routinesAtOnce' | 'helperQuietMinutes' | 'helperMinFreeRamGb' | 'helperMinFreeDiskGb'

/** `none`: what blank means for the row (no limit, or never); `unit`: what the number counts; `decimal`: 1.5 is fine. */
const ROWS: Array<{ key: LimitKey; icon: IconName; title: string; line: string; none?: string; unit?: string; decimal?: boolean }> = [
  { key: 'helpersAtOnce', icon: 'person', title: 'Helpers at once', line: 'How many helpers work at the same time here. The rest wait their turn.' },
  { key: 'helperMaxSteps', icon: 'sliders', title: 'Steps per helper', line: 'A helper stops and says so after this many steps.' },
  { key: 'routinesAtOnce', icon: 'clock', title: 'Routines at once', line: 'How many routine desks work at the same time.' },
  {
    key: 'helperQuietMinutes',
    icon: 'clock',
    title: 'Heads-up on a quiet helper',
    line: 'The agent that started a helper hears once when it takes no new step for this many minutes.',
    none: 'Never',
    unit: 'minutes',
  },
  {
    key: 'helperMinFreeRamGb',
    icon: 'sliders',
    title: 'Pause helpers when memory is low',
    line: 'New helpers wait (one still runs) while free memory is under this, so the app never runs out. Work that can go to a linked server goes there.',
    none: 'No check',
    unit: 'GB',
    decimal: true,
  },
  {
    key: 'helperMinFreeDiskGb',
    icon: 'sliders',
    title: 'Pause helpers when disk is low',
    line: 'New helpers wait (one still runs) while the app\'s drive has less free space than this.',
    none: 'No check',
    unit: 'GB',
    decimal: true,
  },
]

/** The number as the person reads it: blank for no limit. */
function shown(value: number | undefined): string {
  return typeof value === 'number' && value > 0 ? String(value) : ''
}

/** What the person typed, as the setting: 0 for blank, 0 or anything that is not a positive whole number. */
export function limitFromInput(raw: string, decimal = false): number | null {
  const text = raw.trim()
  if (text === '') return 0
  if (!(decimal ? /^\d+(\.\d+)?$/ : /^\d+$/).test(text)) return null
  return Number(text)
}

export function WorkLimits(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  return (
    <>
      {ROWS.map((row) => (
        <LimitRow key={row.key} row={row} value={settings?.[row.key]} />
      ))}
    </>
  )
}

function LimitRow({ row, value }: { row: (typeof ROWS)[number]; value: number | undefined }): JSX.Element {
  const save = useSettings((state) => state.save)
  const [draft, setDraft] = useState(shown(value))
  useEffect(() => setDraft(shown(value)), [value])

  const commit = (): void => {
    const next = limitFromInput(draft, row.decimal === true)
    if (next === null) {
      toast(`Type a ${row.decimal === true ? '' : 'whole '}number, or leave it blank for ${(row.none ?? 'no limit').toLowerCase()}.`)
      setDraft(shown(value))
      return
    }
    if (next === (value ?? 0)) {
      setDraft(shown(next))
      return
    }
    const patch: Partial<Settings> = { [row.key]: next }
    void save(patch).catch(() => toast('Could not change that.'))
  }

  return (
    <div className="rowc">
      <div className="ri">
        <Icon name={row.icon} size={22} />
      </div>
      <div className="rt">
        <b>{row.title}</b>
        <span>
          {value !== undefined && value > 0
            ? row.unit === undefined
              ? `${row.line} Now at most ${value}.`
              : `${row.line} Now ${value} ${row.unit}.`
            : `${row.line} ${row.none ?? 'No limit'}.`}
        </span>
      </div>
      <input
        className="input"
        style={{ width: 104, textAlign: 'right' }}
        inputMode={row.decimal === true ? 'decimal' : 'numeric'}
        aria-label={row.title}
        placeholder={row.none ?? 'No limit'}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
        }}
      />
    </div>
  )
}
