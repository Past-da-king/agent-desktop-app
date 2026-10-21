import { MAIN_CHAT, type AiPicks, type ChatBrain, type ProjectRow } from '@agent/core'
import { useEffect, useRef, useState } from 'react'

import { agent } from '../bridge'
import { pickLine, withPick } from '../lib/ai'
import { useSettings } from '../state/useSettings'
import { AiPickRows } from './AiPickRows'
import { Icon } from './Icon'

/**
 * The AI pill in the chat header: what this chat's agent and its helpers think with. In the main thread it changes
 * the main thread's picks; in a project chat, that project's. A change within the same family applies on the next
 * message; a change of family (a plan to a key, Claude to Codex) applies when the chat starts afresh, and the row
 * says so.
 */
export function ModelPicker({ chat = MAIN_CHAT, project = null }: { chat?: string; project?: ProjectRow | null }): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const [open, setOpen] = useState(false)
  const [brain, setBrain] = useState<ChatBrain | null>(null)
  const root = useRef<HTMLDivElement>(null)

  const refresh = (): void => {
    void agent.settings.accounts
      .chatBrain(chat)
      .then(setBrain)
      .catch(() => setBrain(null))
  }

  useEffect(refresh, [chat, settings, project])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (settings === null) return <span />
  const picks: AiPicks = project === null ? settings.ai : (project.ai ?? { main: { account: '', model: '' }, helpers: { account: '', model: '' } })
  const shown = brain === null ? 'Choose an AI' : pickLine(settings, brain.main.using) || 'Choose an AI'
  const deferred = brain?.main.deferred === true

  const change = (next: AiPicks): void => {
    if (project === null) void save({ ai: next })
    else void agent.data.upsert('project', { id: project.id, ai: next })
  }

  return (
    <div className="model-pick" ref={root}>
      <button type="button" className="model" aria-haspopup="menu" aria-expanded={open} title={open ? undefined : 'Choose what this chat thinks with'} onClick={() => setOpen((value) => !value)}>
        <Icon name="bolt" size={16} />
        <span>{shown}</span>
        {deferred ? <span className="model-wait-dot" aria-label="A change waits for your next new chat" /> : null}
        <Icon name="chevd" size={16} />
      </button>
      {open ? (
        <div className="model-menu ai-menu" role="menu" aria-label="What this chat thinks with">
          <div className="eyebrow mute">{project === null ? 'MAIN THREAD' : project.name.toUpperCase()}</div>
          <AiPickRows
            settings={settings}
            picks={picks}
            {...(project === null ? {} : { inherit: settings.ai })}
            notes={{
              main: deferred ? `Switches when you start a new chat. Until then: ${pickLine(settings, brain?.main.using ?? { account: '', model: '' })}.` : '',
            }}
            onChange={(next) => {
              change(next)
              // A project's change lands in the store; read the chat's brain again once it has.
              window.setTimeout(refresh, 150)
            }}
          />
          <p className="small muted ai-menu-note">
            {project === null ? 'Projects can pick their own.' : 'Same as the main thread follows what Settings says.'}
          </p>
        </div>
      ) : null}
    </div>
  )
}

/** Unused helper kept for callers that only need a pick line. */
export function pickSummary(settings: Parameters<typeof pickLine>[0], picks: AiPicks): string {
  return pickLine(settings, picks.main)
}

export { withPick }
