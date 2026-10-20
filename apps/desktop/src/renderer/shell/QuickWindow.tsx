import type { ChatEvent } from '@agent/core'
import { useEffect, useRef, useState } from 'react'

import { agent, chat } from '../bridge'
import { useSettings } from '../state/useSettings'
import { Icon } from '../ui/Icon'
import { Mascot } from '../ui/Mascot'

/**
 * The small frameless window the global Quick Ask shortcut opens (`#/quick-window`).
 * It sends the typed line through the same chat the main window uses and shows the reply inline,
 * so a quick question does not pull the whole app in front of what the person was doing.
 */
export function QuickWindow(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState('')
  const [problem, setProblem] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const startedAt = useRef(0)

  const agentName = settings?.agentName.trim() || 'Your agent'

  useEffect(() => {
    input.current?.focus()
  }, [])

  useEffect(() => {
    const refresh = async (): Promise<void> => {
      try {
        const rows = await agent.data.list('chat_item')
        const since = startedAt.current
        const reply = rows
          .filter((row) => row.createdAt >= since && (row.kind === 'agent' || row.kind === 'notice'))
          .sort((a, b) => b.createdAt - a.createdAt)[0]
        if (reply) setAnswer(reply.text)
        setBusy(false)
      } catch {
        setBusy(false)
      }
    }

    const offQuick = agent.window.onQuickAsk(() => {
      setText('')
      setAnswer('')
      setProblem('')
      setBusy(false)
      startedAt.current = 0
      input.current?.focus()
    })

    const off = chat.onEvent((event: ChatEvent) => {
      if (event.type === 'run_started') setBusy(true)
      if (event.type === 'chat_changed') void refresh()
      if (event.type === 'needs_you') {
        setBusy(false)
        setAnswer('This needs you in the main window.')
      }
      if (event.type === 'run_finished') {
        if (event.error) setProblem(event.error)
        void refresh()
      }
    })

    return () => {
      offQuick()
      off()
    }
  }, [])

  const send = (): void => {
    const value = text.trim()
    if (value === '' || busy) return
    setBusy(true)
    setAnswer('')
    setProblem('')
    startedAt.current = Date.now()
    setText('')
    chat.send(value).catch((error: unknown) => {
      setBusy(false)
      setProblem(error instanceof Error ? error.message : 'Could not send that.')
    })
  }

  return (
    <div className="quickwin">
      <div className="qw-row">
        <Mascot id={settings?.mascot ?? 'scout'} size={44} busy={busy} />
        <input
          ref={input}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              send()
            }
          }}
          placeholder={`Ask ${agentName} anything`}
          aria-label={`Ask ${agentName}`}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="send"
          onClick={send}
          aria-label="Send"
          disabled={text.trim() === '' || busy}
        >
          <Icon name={busy ? 'clock' : 'arrow'} size={22} />
        </button>
      </div>

      <div className="qw-line">
        {problem !== '' ? (
          <span className="qw-problem" role="alert">
            {problem}
          </span>
        ) : busy ? (
          <span className="qw-status">
            <i className="dot busy" />
            {agentName} is working
          </span>
        ) : answer !== '' ? (
          <span className="qw-answer">{answer}</span>
        ) : (
          <span className="qw-hint">Enter sends. Esc closes. The answer shows here.</span>
        )}
      </div>
    </div>
  )
}
