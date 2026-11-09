/**
 * The one row shape of Settings (4 Nov 2026): an icon tile, the label, a one line description, and one control on the
 * right. A row says its default and offers Reset only while its value is not the default, so a page that has never
 * been touched is quiet. Sub rows are the same row with the tile left out, for things a row owns (a folder, an
 * account, a device).
 */
import type { ReactNode } from 'react'

import { Button } from '../../ui/Button'
import { Icon, type IconName } from '../../ui/Icon'
import { defaultOf, type RowSpec } from './registry'

/** What a number counts, for the default line: "Default: 1000 ms." */
const UNITS: Record<string, string> = {
  helperMinFreeRamGb: ' GB',
  helperMinFreeDiskGb: ' GB',
  helperBusyCpu: '%',
  watchdogMs: ' ms',
  gitMaxFileMb: ' MB',
  helpersAtOnce: '',
  helperMaxSteps: '',
  routinesAtOnce: '',
  helperQuietMinutes: ' minutes',
  wakeupsIdleMinutes: ' minutes',
  wakeupSnoozeMinutes: ' minutes',
  miniappPinCap: '',
  devicesJobLimit: '',
}

/** A value as a person reads it in the default line. */
const WORDS: Record<string, Record<string, string>> = {
  theme: { system: 'system', light: 'light', dark: 'dark' },
  shell: { always: 'run without asking', ask: 'ask first', never: 'never' },
  recordingAudioKeep: { today: 'until the end of today', week: 'a week', always: 'always' },
  helpersRunOn: { best: 'best', here: 'this computer' },
  accent: { iris: 'Iris', ocean: 'Ocean', teal: 'Teal', forest: 'Forest', ember: 'Ember', rose: 'Rose', violet: 'Violet', magenta: 'Magenta' },
  mascot: { scout: 'Scout', ghost: 'Ghost', clover: 'Clover', bloom: 'Bloom', puff: 'Puff', gem: 'Gem', pebble: 'Pebble', heart: 'Heart', bun: 'Bun' },
}

/** The default as words, or '' when there is nothing worth saying (an empty field). */
export function defaultText(spec: RowSpec): string {
  const value = defaultOf(spec.key)
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') {
    if (value === '') return ''
    return WORDS[spec.key]?.[value] ?? value
  }
  if (typeof value === 'number') {
    if (spec.control === 'slider') return `${Math.round(value * 100)}%`
    return `${value}${UNITS[spec.key] ?? ''}`
  }
  return ''
}

export function SettingRow({
  spec,
  changed,
  onReset,
  children,
  icon,
  sub = false,
  stack = false,
  tileSlot,
}: {
  spec: RowSpec
  /** True when the value is not the default: the row then says the default and offers Reset. */
  changed?: boolean
  onReset?: () => void
  children?: ReactNode
  /** A different tile for this row than the section's own (a saved voice shows a tick, for example). */
  icon?: { name: IconName; tone?: 'ok' | 'warn' }
  sub?: boolean
  /** A control too wide for the right side drops under the label instead. */
  stack?: boolean
  /** Pills or a switch drawn instead of an icon tile. */
  tileSlot?: ReactNode
}): JSX.Element {
  const said = defaultText(spec)
  const tone = icon?.tone === undefined ? '' : ` ${icon.tone}`
  return (
    <div className={`srow${sub ? ' sub' : ''}${stack ? ' stack' : ''}`}>
      {sub ? null : (
        <div className={`ri${tone}`}>
          <Icon name={icon?.name ?? spec.icon} size={22} />
        </div>
      )}
      <div className="rt">
        <b>{spec.label}</b>
        <span className="d">
          {spec.description}
          {changed === true && said !== '' ? (
            <>
              {' '}
              <b>Default: {said}.</b>
            </>
          ) : null}
        </span>
      </div>
      <div className="end">
        {children}
        {changed === true && onReset !== undefined ? (
          <Button variant="text" size="sm" onClick={onReset} aria-label={`Reset ${spec.label}`}>
            Reset
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/** One section: its name, the line that says what it is for, and its card of rows. */
export function SectionBlock({
  name,
  line,
  id,
  children,
  extra,
}: {
  name: string
  line: string
  id: string
  children: ReactNode
  extra?: ReactNode
}): JSX.Element {
  return (
    <section className="ssec" id={`set-${id}`} aria-label={name}>
      <div className="ssec-h">
        <span className="eyebrow">{name}</span>
        <span className="line">{line}</span>
      </div>
      <div className="card rows">{children}</div>
      {extra}
    </section>
  )
}
