import type { ChatEvent } from '@agent/core'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

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

  // The window is see-through: only the orb, the pill and the bubble are drawn.
  useEffect(() => {
    document.documentElement.classList.add('quick-own')
    return () => document.documentElement.classList.remove('quick-own')
  }, [])

  // Drag by the orb: the main process moves the window with the real cursor and snaps it. A press that never moved
  // is a click, which puts the cursor back in the field.
  const dragFrom = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const onOrbDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragFrom.current = { x: event.screenX, y: event.screenY, moved: false }
  }
  const onOrbMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const from = dragFrom.current
    if (from === null || from.moved) return
    if (Math.abs(event.screenX - from.x) + Math.abs(event.screenY - from.y) < 4) return
    from.moved = true
    agent.window.quickDrag?.('start')
  }
  const onOrbUp = (): void => {
    const from = dragFrom.current
    dragFrom.current = null
    if (from?.moved === true) agent.window.quickDrag?.('end')
    input.current?.focus()
  }

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

  const showing = walkQuestion !== null
  const sentOrBusy = waiting || running
  // Help only where it is needed: nothing while he types a plain ask, one short line for the mode he is in.
  const bubble: JSX.Element | null = dictating ? (
    <span className="qo-dict">
      <DictationDraft compact />
    </span>
  ) : problem !== '' ? (
    <span className="qo-problem" role="alert">
      {problem}
    </span>
  ) : answer !== '' ? (
    <span className="qo-answer">{answer}</span>
  ) : waiting ? (
    <span role="status">Sent. I'm on it.</span>
  ) : showing ? (
    <span>
      I'll show you on screen, one step at a time. <kbd>Ctrl</kbd> <kbd>Enter</kbd> asks instead.
    </span>
  ) : null

  return (
    <div className={`qo${showing ? ' show' : ''}${dictating ? ' listening' : ''}`}>
      <div className="qo-row">
        <button
          type="button"
          className="qo-orb"
          aria-label="Move the quick ask bar"
          title="Drag to move"
          onPointerDown={onOrbDown}
          onPointerMove={onOrbMove}
          onPointerUp={onOrbUp}
          onPointerCancel={onOrbUp}
        >
          {dictating ? (
            <>
              <i className="qo-ring" />
              <i className="qo-ring late" />
            </>
          ) : null}
          {showing ? (
            <svg className="qo-point" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
              <path d="M5 4l6.5 16 2.4-6.9L21 10.6z" />
            </svg>
          ) : (
            <Mascot id={settings?.mascot ?? 'scout'} size={38} busy={sentOrBusy || dictating} />
          )}
          {waiting ? (
            <span className="qo-badge">
              <Icon name="check" size={12} />
            </span>
          ) : null}
        </button>

        <div className="qo-pill">
          <input
            ref={input}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                send(event.ctrlKey || event.metaKey)
              } else if (event.key === 'Tab' && canShow) {
                event.preventDefault()
                setShowMode((on) => !on)
              }
            }}
            placeholder={showing || showMode ? 'What should I show you?' : `Ask ${agentName}`}
            aria-label={`Message ${agentName}`}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className={`qo-icon${dictating ? ' on' : ''}`}
            aria-pressed={dictating}
            aria-label="Dictate"
            title={dictateKeys === '' ? 'Dictate' : `Dictate (${dictateKeys})`}
            onClick={() => {
              void agent.dictation.toggle('plain').catch(() => undefined)
              input.current?.focus()
            }}
          >
            <Icon name="mic" size={18} />
          </button>
          {canShow ? (
            <button
              type="button"
              className={`qo-icon${showMode || showing ? ' on' : ''}`}
              aria-pressed={showMode}
              aria-label="Show me on screen"
              title="Show me on screen (Tab)"
              onClick={() => {
                setShowMode((on) => !on)
                input.current?.focus()
              }}
            >
              <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                <path d="M5 4l6.5 16 2.4-6.9L21 10.6z" />
              </svg>
            </button>
          ) : null}
          <button
            type="button"
            className={`qo-send${text.trim() === '' ? '' : ' ready'}`}
            onClick={() => send()}
            aria-label={showing ? 'Show me on screen' : 'Send'}
            disabled={text.trim() === ''}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>

      {bubble !== null ? <div className="qo-bubble">{bubble}</div> : null}
    </div>
  )
}
