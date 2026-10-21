import type { HotkeyAction, HotkeyStatus, Settings } from '@agent/core'
import { useEffect, useRef, useState } from 'react'

import { agent } from '../bridge'
import { acceleratorFromEvent, cleanSwitchKeys, formatAccelerator } from '../lib/hotkey'
import { useSettings } from '../state/useSettings'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'

type Field = 'quickAskHotkey' | 'dictateHotkey' | 'dictateCleanHotkey'

interface Row {
  action: HotkeyAction
  field: Field
  icon: 'bolt' | 'mic' | 'edit'
  title: string
  line: (settings: Settings | null, platform: string) => string
}

const ROWS: Row[] = [
  {
    action: 'quickAsk',
    field: 'quickAskHotkey',
    icon: 'bolt',
    title: 'Quick chat',
    line: () => 'A small message box over any app. Enter sends it to your chat, Esc closes it.',
  },
  {
    action: 'dictate',
    field: 'dictateHotkey',
    icon: 'mic',
    title: 'Dictation',
    line: () => 'Types what you say where the cursor is, in any app. Press again to stop, or pause for a few seconds.',
  },
  {
    action: 'dictateClean',
    field: 'dictateCleanHotkey',
    icon: 'edit',
    title: 'Dictate and clean up',
    line: (settings, platform) => {
      const switchKeys = cleanSwitchKeys(settings?.dictateHotkey ?? '', platform)
      const base = 'The same, with fillers and false starts taken out and the punctuation fixed.'
      return switchKeys === '' ? base : `${base} While dictating, ${switchKeys} switches to this.`
    },
  },
]

function Recorder({
  value,
  platform,
  label,
  onSave,
}: {
  value: string
  platform: string
  label: string
  onSave: (accelerator: string) => void
}): JSX.Element {
  const [recording, setRecording] = useState(false)
  const saveRef = useRef(onSave)
  saveRef.current = onSave

  useEffect(() => {
    if (!recording) return
    // Our own shortcuts step aside while recording, or pressing one would start it instead of being heard here.
    void agent.hotkeys.pause(true).catch(() => undefined)
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(false)
        return
      }
      const accelerator = acceleratorFromEvent(event, platform)
      if (accelerator === null) return
      setRecording(false)
      saveRef.current(accelerator)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      void agent.hotkeys.pause(false).catch(() => undefined)
    }
  }, [recording, platform])

  const keys = formatAccelerator(value, platform)

  return (
    <div className="kbds">
      {recording ? (
        <span className="small muted">Press the keys now, Esc to stop</span>
      ) : keys.length > 0 ? (
        keys.map((key) => <kbd key={key}>{key}</kbd>)
      ) : (
        <span className="small muted">No shortcut</span>
      )}
      <Button variant="tonal" size="sm" aria-label={`Record a shortcut for ${label}`} onClick={() => setRecording(!recording)}>
        {recording ? 'Listening...' : 'Record'}
      </Button>
      {keys.length > 0 && !recording ? (
        <Button variant="text" size="sm" aria-label={`Turn off the ${label} shortcut`} onClick={() => saveRef.current('')}>
          Turn off
        </Button>
      ) : null}
    </div>
  )
}

/** Settings rows for the global shortcuts: each one's keys, a recorder, and whether it is live or what is in its way. */
export function HotkeySettings(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const [statuses, setStatuses] = useState<Partial<Record<HotkeyAction, HotkeyStatus>>>({})

  useEffect(() => {
    let live = true
    agent.hotkeys
      .status()
      .then((list) => {
        if (!live) return
        const next: Partial<Record<HotkeyAction, HotkeyStatus>> = {}
        for (const status of list) next[status.action ?? 'quickAsk'] = status
        setStatuses(next)
      })
      .catch(() => {
        // The rows still work; the status line simply waits for the next change.
      })
    const off = agent.window.onHotkeyStatus((status) => {
      setStatuses((current) => ({ ...current, [status.action ?? 'quickAsk']: status }))
    })
    return () => {
      live = false
      off()
    }
  }, [])

  return (
    <>
      {ROWS.map((row) => {
        const status = statuses[row.action]
        const value = settings?.[row.field] ?? ''
        const stale = status !== undefined && status.accelerator !== value
        return (
          <div key={row.action}>
            <div className="rowc" style={{ flexWrap: 'wrap' }}>
              <div className="ri">
                <Icon name={row.icon} size={22} />
              </div>
              <div className="rt">
                <b>{row.title}</b>
                <span>{row.line(settings, agent.platform)}</span>
              </div>
              <Recorder
                value={value}
                platform={agent.platform}
                label={row.title}
                onSave={(accelerator) => {
                  void save({ [row.field]: accelerator } as Partial<Settings>)
                }}
              />
            </div>
            {status !== undefined && !stale ? (
              <div
                className={`small hotkey-status${status.ok ? ' muted' : ' bad'}`}
                role={status.ok ? undefined : 'alert'}
                style={{ padding: '0 18px 12px 78px' }}
              >
                {status.message}
              </div>
            ) : null}
          </div>
        )
      })}
    </>
  )
}
