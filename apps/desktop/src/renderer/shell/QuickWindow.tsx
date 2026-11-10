import type { ChatEvent } from '@agent/core'
import { useEffect, useRef, useState } from 'react'

import { agent, chat } from '../bridge'
import { formatAccelerator } from '../lib/hotkey'
import { howToQuestion } from '../../shared/showme'
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
 *
 * Show me how (10 Nov 2026): a line that starts as a how-to ("how do I...", "show me how...") or is typed with the
 * Show me chip on is not sent to the chat: the bar closes and the steps are ringed, one at a time, on the window he
 * was on. The hint says which of the two Enter will do before he presses it, and Ctrl+Enter always sends to the chat.
 */
export function QuickWindow(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const [text, setText] = useState('')
  const [running, setRunning] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [answer, setAnswer] = useState('')
  const [problem, setProblem] = useState('')
  const [showMode, setShowMode] = useState(false)
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
        // Only the replies since the question, by index: never the whole chat table.
        const rows = await agent.data.where('chat_item', { kinds: ['agent', 'notice'], since: since - 1, newestFirst: true, limit: 20 })
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
      setShowMode(false)
      sentAt.current = 0
      input.current?.focus()
      // A walk that could not start brought the bar back: it says why.
      void agent.showMe
        ?.state()
        .then((state) => {
          if (state.phase === 'ended' && state.failed && state.message !== '' && Date.now() - state.at < 15_000) {
            setText(state.question)
            setProblem(state.message)
          }
        })
        .catch(() => undefined)
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

  // What Enter will do with this line: show it on his screen, or send it to the chat.
  const canShow = agent.showMe !== undefined
  const walkQuestion = !canShow || text.trim() === '' ? null : showMode ? text.trim() : howToQuestion(text)

  const showOnScreen = (question: string): void => {
    setProblem('')
    setAnswer('')
    void agent.showMe
      ?.start(question)
      .then((started) => {
        // Started: the bar is closed by the main process and the ring is on his window.
        if (started.ok) setText('')
        else setProblem(started.message)
      })
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : 'Could not start that.'))
  }

  const send = (toChat = false): void => {
    const value = text.trim()
    if (value === '') return
    if (!toChat && walkQuestion !== null) {
      showOnScreen(walkQuestion)
      return
    }
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
              send(event.ctrlKey || event.metaKey)
            }
          }}
          placeholder={showMode ? 'What do you want to be shown?' : `Message ${agentName}`}
          aria-label={`Message ${agentName}`}
          autoComplete="off"
          spellCheck={false}
        />
        {canShow ? (
          <button type="button" className={`chip${showMode ? ' on' : ''}`} aria-pressed={showMode} title="Show the steps on the window you were on" onClick={() => { setShowMode((on) => !on); input.current?.focus() }}>
            Show me
          </button>
        ) : null}
        <button type="button" className="send" onClick={() => send()} aria-label={walkQuestion !== null ? 'Show me on screen' : 'Send'} disabled={text.trim() === ''}>
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
        ) : walkQuestion !== null ? (
          <span className="qw-hint">Enter shows you the steps on the window you were on. Ctrl+Enter sends it to your chat instead.</span>
        ) : (
          <span className="qw-hint">
            Enter sends to your chat. Esc closes.{dictateKeys === '' ? '' : ` ${dictateKeys} to dictate.`}
            {canShow ? ' Start with "how do I" to be shown on screen.' : ''}
          </span>
        )}
      </div>
    </div>
  )
}
