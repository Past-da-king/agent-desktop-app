import type { ChatEvent } from '@agent/core'
import { useEffect, useRef, useState } from 'react'

import { agent, chat } from '../bridge'
import { formatAccelerator } from '../lib/hotkey'
import { useSettings } from '../state/useSettings'
import { Icon } from '../ui/Icon'
import { Mascot } from '../ui/Mascot'
import { plainText } from '../openui/lang'
import { DictationDraft, useDictationDraft } from '../voice/DictationDraft'
import '../voice/voice.css'

/**
 * The small frameless window the global Quick chat shortcut opens (`#/quick-window`), over whatever app is in
 * front. Enter sends the line into the one chat the main window shows (while the agent is busy it joins the run,
 * as it does from the main window), and the reply shows here in a line or two. Esc or a click elsewhere closes it.
 * Paste works as in any text box; the dictation shortcut types into it like into any app.
 */
export function QuickWindow(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const [text, setText] = useState('')
  const [running, setRunning] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [answer, setAnswer] = useState('')
  const [problem, setProblem] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const sentAt = useRef(0)

  const agentName = settings?.agentName.trim() || 'Your agent'
  const dictateKeys = formatAccelerator(settings?.dictateHotkey ?? '', agent.platform).join('+')

  useEffect(() => {
    input.current?.focus()
    void chat
      .state()
      .then((state) => setRunning(state.running))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const refresh = async (): Promise<void> => {
      const since = sentAt.current
      if (since === 0) return
      try {
        const rows = await agent.data.list('chat_item')
        const reply = rows
          .filter((row) => row.createdAt >= since && (row.kind === 'agent' || row.kind === 'notice'))
          .sort((a, b) => b.createdAt - a.createdAt)[0]
        // Cards cannot be drawn in the small window: a card answer shows as the titles of what it holds.
        if (reply) {
          setAnswer(reply.kind === 'agent' ? plainText(reply.text) : reply.text)
          setWaiting(false)
        }
      } catch {
        // The answer is in the main window either way.
      }
    }

    const offQuick = agent.window.onQuickAsk(() => {
      setText('')
      setAnswer('')
      setProblem('')
      setWaiting(false)
      sentAt.current = 0
      input.current?.focus()
    })

    // The reply lands as a row change; the list is read only once the run ends, in case a change was missed.
    const offData = agent.data.onChanged((change) => {
      const since = sentAt.current
      if (since === 0 || change.entity !== 'chat_item' || change.row === undefined) return
      const row = change.row as { createdAt: number; kind: string; text: string }
      if (row.createdAt < since || (row.kind !== 'agent' && row.kind !== 'notice')) return
      setAnswer(row.kind === 'agent' ? plainText(row.text) : row.text)
      setWaiting(false)
    })
    const off = chat.onEvent((event: ChatEvent) => {
      if (event.type === 'run_started') setRunning(true)
      if (event.type === 'needs_you' && sentAt.current !== 0) {
        setWaiting(false)
        setAnswer(`${agentName} needs you in the main window.`)
      }
      if (event.type === 'run_finished') {
        setRunning(false)
        if (event.error && sentAt.current !== 0) setProblem(event.error)
        void refresh().then(() => setWaiting(false))
      }
    })

    return () => {
      offData()
      offQuick()
      off()
    }
  }, [agentName])

  const dictating = useDictationDraft() !== null

  const send = (): void => {
    const value = text.trim()
    if (value === '') return
    setWaiting(true)
    setAnswer('')
    setProblem('')
    sentAt.current = Date.now()
    setText('')
    chat.send(value).catch((error: unknown) => {
      setWaiting(false)
      setProblem(error instanceof Error ? error.message : 'Could not send that.')
    })
    input.current?.focus()
  }

  return (
    <div className="quickwin">
      <div className="qw-row">
        <Mascot id={settings?.mascot ?? 'scout'} size={44} busy={running || waiting} />
        <input
          ref={input}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
          placeholder={`Message ${agentName}`}
          aria-label={`Message ${agentName}`}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="button" className="send" onClick={send} aria-label="Send" disabled={text.trim() === ''}>
          <Icon name="arrow" size={22} />
        </button>
      </div>

      <div className="qw-line">
        {/* The shortcut pressed here dictates into this box: the words show on this line, never in the pill. */}
        {dictating ? (
          <DictationDraft compact />
        ) : problem !== '' ? (
          <span className="qw-problem" role="alert">
            {problem}
          </span>
        ) : waiting ? (
          <span className="qw-status" role="status">
            <i className="dot busy" />
            Sent. {agentName} is on it, and the answer shows here and in your chat.
          </span>
        ) : answer !== '' ? (
          <span className="qw-answer">{answer}</span>
        ) : (
          <span className="qw-hint">
            Enter sends to your chat. Esc closes.{dictateKeys === '' ? '' : ` ${dictateKeys} to dictate.`}
          </span>
        )}
      </div>
    </div>
  )
}
