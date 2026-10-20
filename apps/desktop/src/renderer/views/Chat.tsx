import { attachmentProblem, type Attachment, type ChatEvent, type ChatItem } from '@agent/core'
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'

import { agent, chat } from '../bridge'
import { openCards } from '../lib/cards'
import { attachmentsFromMeta, isImageFile } from '../lib/files'
import { helperView, type HelperView } from '../lib/helpers'
import { isDivider, threadItems, threadTitle } from '../lib/thread'
import { metaStrings, metaText, parseMeta } from '../lib/meta'
import { refreshEntity, useEntity, useEntityLoaded } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { useWaiting } from '../state/useWaiting'
import { toast } from '../state/useToast'
import { CallRow } from '../voice/CallRow'
import { CallSheet } from '../voice/CallSheet'
import { DictateButton } from '../voice/DictateButton'
import { ReadAloud } from '../voice/ReadAloud'
import { useSpeakReplies } from '../voice/speaker'
import { useCall } from '../voice/useCall'
import { VisualCard, visualFromMeta } from '../voice/VisualCard'
import { VoiceIcon } from '../voice/VoiceIcon'
import { Button } from '../ui/Button'
import { IconButton, Kbd, Pill } from '../ui/bits'
import { Chip } from '../ui/Chip'
import { Dialog } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { Icon, type IconName } from '../ui/Icon'
import { Markdown } from '../ui/Markdown'
import { ModelPicker } from '../ui/ModelPicker'
import { Mascot } from '../ui/Mascot'
import { Skeleton } from '../ui/Skeleton'

const TOOL_ICONS: Record<string, IconName> = {
  memory_search: 'memory',
  memory_get: 'memory',
  memory_save: 'memory',
  memory_update: 'memory',
  web_fetch: 'globe',
  task_add: 'tasks',
  task_list: 'tasks',
  task_update: 'tasks',
  goal_create: 'bolt',
  ask_user: 'chat',
  request_approval: 'shield',
  notify_user: 'bell',
  report: 'chat',
  now: 'clock',
}

const TOOL_LABELS: Record<string, string> = {
  memory_search: 'Memory search',
  memory_get: 'Memory page',
  memory_save: 'Memory saved',
  memory_update: 'Memory updated',
  web_fetch: 'Web',
  task_add: 'To-do added',
  task_list: 'To-dos',
  task_update: 'To-do updated',
  goal_create: 'Goal',
  ask_user: 'Asking you',
  request_approval: 'Approval',
  notify_user: 'Notification',
  report: 'Report',
  now: 'Clock',
}

function toolIcon(tool: string): IconName {
  return TOOL_ICONS[tool] ?? 'bolt'
}

function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? 'Tool'
}

function useThumbnail(file: Attachment): string | null {
  const [src, setSrc] = useState<string | null>(null)
  const image = isImageFile(file)

  useEffect(() => {
    if (!image) {
      setSrc(null)
      return
    }
    let live = true
    agent.files
      .thumbnail(file.path)
      .then((url) => {
        if (live) setSrc(url)
      })
      .catch(() => {
        // A thumbnail is a nicety: a file that cannot be read still attaches by path.
      })
    return () => {
      live = false
    }
  }, [file.path, image])

  return src
}

function AttachmentChip({ file, onRemove }: { file: Attachment; onRemove: () => void }): JSX.Element {
  const src = useThumbnail(file)
  return (
    <button type="button" className="chip on att" onClick={onRemove} aria-label={`Remove ${file.name}`}>
      {src !== null ? <img className="thumb" src={src} alt="" /> : <Icon name="clip" size={14} />}
      <span className="att-name">{file.name}</span>
      <Icon name="x" size={14} />
    </button>
  )
}

function MessageAttachment({ file }: { file: Attachment }): JSX.Element {
  const src = useThumbnail(file)
  if (isImageFile(file) && src !== null) {
    return (
      <div className="u-file">
        <img src={src} alt={file.name} />
        <span>{file.name}</span>
      </div>
    )
  }
  return (
    <div className="u-file plain">
      <Icon name="clip" size={18} />
      <span>{file.name}</span>
    </div>
  )
}

function ActivityRow({ item }: { item: ChatItem }): JSX.Element {
  const meta = parseMeta(item.meta)
  const tool = metaText(meta, 'tool')
  const status = metaText(meta, 'status') || 'done'
  const summary = metaText(meta, 'summary') || item.text
  const icon: IconName = status === 'error' ? 'x' : status === 'running' ? toolIcon(tool) : 'check'
  return (
    <div className={`tool ${status}`} title={tool === '' ? undefined : tool}>
      <i className={status === 'running' ? 'spin' : ''}>
        <Icon name={icon} size={16} />
      </i>
      <span className="tool-tag">{toolLabel(tool)}</span>
      <span className="tool-sum">{summary}</span>
    </div>
  )
}

type Segment = { kind: 'item'; item: ChatItem } | { kind: 'tools'; id: string; items: ChatItem[] }

/** Back-to-back tool steps become ONE row: the live step while it runs, then a single summary. */
function segmentsOf(messages: ChatItem[]): Segment[] {
  const out: Segment[] = []
  for (const item of messages) {
    const last = out[out.length - 1]
    if (item.kind === 'activity' && last !== undefined && last.kind === 'tools') last.items.push(item)
    else if (item.kind === 'activity') out.push({ kind: 'tools', id: item.id, items: [item] })
    else out.push({ kind: 'item', item })
  }
  return out
}

function ToolSteps({ items, live }: { items: ChatItem[]; live: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  const statuses = items.map((item) => metaText(parseMeta(item.meta), 'status') || 'done')
  const running = live && statuses.includes('running')
  const failed = statuses.filter((status) => status === 'error').length
  const current = [...items].reverse().find((_, index) => statuses[items.length - 1 - index] === 'running') ?? items[items.length - 1]
  if (running && current !== undefined) {
    return (
      <div className="tool-live">
        <ActivityRow item={current} />
        {items.length > 1 ? <span className="tool-count">Step {items.length}</span> : null}
      </div>
    )
  }
  if (items.length === 1 && items[0] !== undefined) return <ActivityRow item={items[0]} />
  return (
    <div className="tool-group">
      <button type="button" className="tool-sum-row" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <i>
          <Icon name={failed > 0 ? 'x' : 'check'} size={16} />
        </i>
        <span>
          Used {items.length} tools{failed > 0 ? `, ${failed} failed` : ''}
        </span>
        <Icon name={open ? 'chevd' : 'chev'} size={16} />
      </button>
      {open ? (
        <div className="tool-list">
          {items.map((item) => (
            <ActivityRow key={item.id} item={item} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function QuestionRow({ item }: { item: ChatItem }): JSX.Element {
  const meta = parseMeta(item.meta)
  const options = metaStrings(meta, 'options')
  const answered = typeof meta['answer'] === 'string' && meta['answer'] !== ''
  const [custom, setCustom] = useState('')
  const [sending, setSending] = useState(false)

  if (answered) {
    return (
      <div className="appr done">
        <div className="eyebrow">
          <Icon name="check" size={14} />
          ANSWERED
        </div>
        <div className="tt">{item.text}</div>
        <div className="hint">You picked {metaText(meta, 'answer')}.</div>
      </div>
    )
  }

  const answer = (value: string): void => {
    const clean = value.trim()
    if (clean === '' || sending) return
    setSending(true)
    void chat.answer(item.id, clean).catch(() => setSending(false))
  }

  // browser_handoff asks with these two options. Draw it as a handoff card, not a generic question.
  const handoff = options.includes('Done, carry on')
  if (handoff) {
    return (
      <div className="appr handoff">
        <div className="eyebrow">
          <Icon name="globe" size={14} />
          YOUR TURN IN THE BROWSER
        </div>
        <div className="tt">{item.text}</div>
        <div className="acts appr-acts">
          <Button disabled={sending} onClick={() => answer('Done, carry on')}>
            Done, carry on
          </Button>
          <button type="button" className="ans" disabled={sending} onClick={() => answer('Skip')}>
            Skip
          </button>
        </div>
        <div className="hint">The page is yours while this card is open. Finish the step, then carry on.</div>
      </div>
    )
  }

  return (
    <div className="appr">
      <div className="eyebrow">
        <Icon name="bolt" size={14} />
        QUESTION
      </div>
      <div className="tt">{item.text}</div>
      {options.length > 0 ? (
        <div className="acts">
          {options.map((option) => (
            <button key={option} type="button" className="ans" disabled={sending} onClick={() => answer(option)}>
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="free"
        onSubmit={(event) => {
          event.preventDefault()
          answer(custom)
        }}
      >
        <input
          type="text"
          aria-label="Your answer"
          placeholder="Or type your own answer"
          value={custom}
          disabled={sending}
          onChange={(event) => setCustom(event.target.value)}
        />
        <button type="submit" className="btn fill free-send" disabled={custom.trim() === '' || sending}>
          Answer
        </button>
      </form>
      <div className="hint">The run waits until you answer.</div>
    </div>
  )
}

function ApprovalRow({ item }: { item: ChatItem }): JSX.Element {
  const meta = parseMeta(item.meta)
  const decision = metaText(meta, 'decision')
  const summary = metaText(meta, 'summary') || item.text
  const details = metaText(meta, 'details')
  const [sending, setSending] = useState(false)

  if (decision === 'approve' || decision === 'decline') {
    const approved = decision === 'approve'
    return (
      <div
        className="appr done"
        style={approved ? undefined : { background: 'var(--s-low)', color: 'var(--on-bg)' }}
      >
        <div className="eyebrow" style={approved ? undefined : { color: 'var(--on-sv)' }}>
          <Icon name={approved ? 'check' : 'x'} size={14} />
          {approved ? 'APPROVED' : 'DECLINED'}
        </div>
        <div className="tt">{summary}</div>
        <div className="hint">
          {approved ? 'The work can go ahead now.' : 'Nothing was done. Tell me what to change if you want another try.'}
        </div>
      </div>
    )
  }

  const decide = (value: 'approve' | 'decline'): void => {
    if (sending) return
    setSending(true)
    void chat.decide(item.id, value).catch(() => setSending(false))
  }

  return (
    <div className="appr">
      <div className="eyebrow">
        <Icon name="shield" size={14} />
        APPROVE BEFORE I DO THIS
      </div>
      <div className="tt">{summary}</div>
      {details ? <pre>{details}</pre> : null}
      <div className="acts appr-acts">
        <Button disabled={sending} onClick={() => decide('approve')}>
          Approve and go ahead
        </Button>
        <button type="button" className="ans" disabled={sending} onClick={() => decide('decline')}>
          Decline
        </button>
      </div>
      <div className="hint">Nothing happens until you approve.</div>
    </div>
  )
}

function reportText(item: ChatItem): { title: string; markdown: string; words: number } {
  const meta = parseMeta(item.meta)
  const raw = metaText(meta, 'markdown') || item.text
  const title = metaText(meta, 'title') || item.text || 'Report'
  const trimmed = raw.replace(/^\s+/, '')
  const heading = /^(#{1,6})\s+(.*)\r?\n?/.exec(trimmed)
  const markdown =
    heading !== null && (heading[2] ?? '').trim().toLowerCase() === title.trim().toLowerCase()
      ? trimmed.slice(heading[0].length).replace(/^\s+/, '')
      : raw
  const words =
    typeof meta['words'] === 'number' && Number.isFinite(meta['words'])
      ? meta['words']
      : markdown.split(/\s+/).filter(Boolean).length
  return { title, markdown, words }
}

function plainPreview(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function ReportRow({ item, onOpen }: { item: ChatItem; onOpen: (item: ChatItem) => void }): JSX.Element {
  const report = reportText(item)
  const preview = plainPreview(report.markdown)
  return (
    <div className="report">
      <div className="report-top">
        <span className="eyebrow">REPORT</span>
        <span className="report-words">
          {report.words} {report.words === 1 ? 'word' : 'words'}
        </span>
      </div>
      <div className="report-title">{report.title}</div>
      <div className="report-preview">{preview.length > 260 ? `${preview.slice(0, 257)}...` : preview}</div>
      <div>
        <Button variant="tonal" size="sm" onClick={() => onOpen(item)}>
          Read the report
        </Button>
      </div>
    </div>
  )
}

function UserRow({ item }: { item: ChatItem }): JSX.Element {
  const files = attachmentsFromMeta(parseMeta(item.meta)['attachments'])
  return (
    <div className="u-row">
      {item.text !== '' ? <div className="u-msg">{item.text}</div> : null}
      {files.length > 0 ? (
        <div className="u-files">
          {files.map((file) => (
            <MessageAttachment key={`${file.path}-${file.name}`} file={file} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function HelperRow({ helper }: { helper: HelperView }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const live = helper.state === 'working'
  const tone = live ? (helper.queued ? 'mute' : 'pri') : helper.state === 'done' ? 'ok' : 'warn'
  const label = live ? (helper.queued ? 'Queued' : 'Working') : helper.state === 'done' ? 'Done' : helper.state === 'failed' ? 'Failed' : 'Stopped'
  const icon: IconName = live ? 'globe' : helper.state === 'done' ? 'check' : helper.state === 'failed' ? 'x' : 'stop'
  const bodyId = `helper-steps-${helper.id.replace(/[^a-zA-Z0-9_-]/g, '')}`

  const stop = (): void => {
    if (stopping) return
    setStopping(true)
    void agent.helpers
      .stop(helper.id)
      .then((ok) => {
        if (!ok) setStopping(false)
      })
      .catch(() => setStopping(false))
  }

  return (
    <div className="hcard">
      <div className={`hrow${open ? ' open' : ''}`}>
        <button
          type="button"
          className="hmain"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        >
          <span className={`hs${live ? ' work' : ''}`}>
            <Icon name={icon} size={20} />
          </span>
          <span className="hn">
            <b>{helper.label}</b>
            <Pill tone={tone}>{label}</Pill>
            <div>{helper.summary || (helper.queued ? 'Waiting its turn' : live ? 'Working' : 'Finished')}</div>
          </span>
          <span className="hchev">
            <Icon name="chev" size={20} />
          </span>
        </button>
        {live ? (
          <Button
            variant="text"
            size="sm"
            className="hstop"
            disabled={stopping}
            aria-label={`Stop ${helper.label}`}
            onClick={stop}
          >
            Stop
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="hbody" id={bodyId}>
          <div className="hbrief">{helper.brief}</div>
          {helper.activity.length === 0 ? (
            <div className="hbrief">No steps yet.</div>
          ) : (
            <div className="hacts">
              {helper.activity.map((activity) => (
                <ActivityRow key={activity.id} item={activity} />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

function renderItem(
  item: ChatItem,
  items: ChatItem[],
  onOpenReport: (item: ChatItem) => void,
  agentName = 'Your agent',
): JSX.Element {
  switch (item.kind) {
    case 'user':
      return <UserRow item={item} />
    case 'agent': {
      const visual = visualFromMeta(parseMeta(item.meta))
      return (
        <div className="a-msg">
          {visual === null ? <Markdown text={item.text} /> : <VisualCard visual={visual} compact />}
          <ReadAloud id={item.id} text={item.text} />
        </div>
      )
    }
    case 'call':
      return <CallRow item={item} agentName={agentName} />
    case 'activity':
      return <ActivityRow item={item} />
    case 'question':
      return <QuestionRow item={item} />
    case 'approval':
      return <ApprovalRow item={item} />
    case 'helper':
      return <HelperRow helper={helperView(item, items)} />
    case 'report':
      return <ReportRow item={item} onOpen={onOpenReport} />
    case 'notice':
      if (isDivider(item)) {
        return (
          <div className="divider" role="separator">
            <span>{item.text || 'New chat'}</span>
          </div>
        )
      }
      return (
        <div className="from">
          <Icon name={parseMeta(item.meta)['from'] === 'phone' ? 'phone' : 'bell'} size={14} />
          {item.text}
        </div>
      )
    default:
      return <div className="from">{item.text}</div>
  }
}

export function Chat(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const items = useEntity('chat_item')
  const loaded = useEntityLoaded('chat_item')
  const focusToken = useUi((state) => state.composerFocus)
  const scrollToken = useUi((state) => state.chatScroll)
  const waiting = useWaiting()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attachProblem, setAttachProblem] = useState('')
  const [dragging, setDragging] = useState(false)
  const [running, setRunning] = useState(false)
  const [reader, setReader] = useState<ChatItem | null>(null)
  const thread = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const stuck = useRef(true)
  const dragDepth = useRef(0)

  const messages = useMemo(() => threadItems(items), [items])
  const segments = useMemo(() => segmentsOf(messages), [messages])
  const title = threadTitle(items)
  const cards = openCards(items, true)
  const needsYou = waiting.length > 0 || cards.length > 0
  const agentName = settings?.agentName.trim() || 'Your agent'
  const startCall = useCall((state) => state.start)
  useSpeakReplies(settings?.speakReplies === true && settings.hasVoiceKey)

  useEffect(() => {
    // The browser preview can open straight into a call (?demo=1&call=1), so the call view can be screenshotted.
    if (agent.platform === 'web' && new URLSearchParams(window.location.search).get('call') === '1') void startCall()
  }, [startCall])

  useEffect(() => {
    let alive = true
    void chat.state().then((state) => {
      if (alive) setRunning(state.running)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const off = chat.onEvent((event: ChatEvent) => {
      if (event.type === 'run_started' || event.type === 'thinking') setRunning(true)
      if (event.type === 'run_finished') setRunning(false)
      if (event.type === 'chat_changed' || event.type === 'needs_you') refreshEntity('chat_item')
    })
    return off
  }, [])

  useEffect(() => {
    const el = thread.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [items, running, loaded])

  useEffect(() => {
    if (scrollToken === 0) return
    stuck.current = true
    const timer = window.setTimeout(() => {
      const el = thread.current
      if (el) el.scrollTop = el.scrollHeight
    }, 0)
    return () => window.clearTimeout(timer)
  }, [scrollToken])

  useEffect(() => {
    if (focusToken === 0) return
    const draft = useUi.getState().composerDraft
    if (draft !== '') {
      setText(draft)
      useUi.setState({ composerDraft: '' })
    }
    composer.current?.focus()
  }, [focusToken])

  useEffect(() => {
    const area = composer.current
    if (!area) return
    area.style.height = '48px'
    area.style.height = `${Math.min(area.scrollHeight, 140)}px`
  }, [text])

  const send = (): void => {
    const value = text.trim()
    if (value === '' && attachments.length === 0) return
    stuck.current = true
    setText('')
    setAttachments([])
    setAttachProblem('')
    void chat.send(value, attachments)
  }

  const accept = (incoming: Attachment[]): void => {
    if (incoming.length === 0) return
    setAttachments((current) => {
      const known = new Set(current.map((item) => item.path))
      return [...current, ...incoming.filter((item) => !known.has(item.path))]
    })
  }

  const pickFiles = async (): Promise<void> => {
    try {
      const picked = await agent.files.pick()
      const problems: string[] = []
      const allowed: Attachment[] = []
      for (const file of picked) {
        const problem = file.size === undefined ? null : attachmentProblem(file.name, file.size)
        if (problem !== null) problems.push(problem)
        else allowed.push(file)
      }
      accept(allowed)
      setAttachProblem(problems[0] ?? '')
    } catch (error) {
      setAttachProblem(error instanceof Error ? error.message : 'Could not open the file picker.')
    }
  }

  const report = reader === null ? null : reportText(reader)
  // While a card is waiting the run is suspended on the person, not thinking.
  const thinking = running && !needsYou

  const hasFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer.types).includes('Files')

  const onDragEnter = (event: DragEvent): void => {
    if (!hasFiles(event)) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }

  const onDragOver = (event: DragEvent): void => {
    if (!hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const onDragLeave = (event: DragEvent): void => {
    if (!hasFiles(event)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  const onDrop = (event: DragEvent): void => {
    if (!hasFiles(event)) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)

    const dropped = Array.from(event.dataTransfer.files)
    if (dropped.length === 0) return
    const paths = agent.files.pathsFor(dropped)
    const problems: string[] = []
    const allowed: Attachment[] = []
    dropped.forEach((file, index) => {
      const problem = attachmentProblem(file.name, file.size)
      if (problem !== null) {
        problems.push(problem)
        return
      }
      const path = paths[index]
      if (path === undefined || path === '') return
      allowed.push({
        path,
        name: file.name,
        mime: file.type === '' ? 'application/octet-stream' : file.type,
        size: file.size,
      })
    })
    accept(allowed)
    setAttachProblem(problems[0] ?? '')
  }

  return (
    <div
      className="chat"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="chat-h">
        <Mascot id={settings?.mascot ?? 'scout'} size={40} busy={!needsYou} needsYou={needsYou} />
        <div className="ttl">
          <b>{title}</b>
          <span className={needsYou ? 'warn' : ''}>
            {needsYou ? 'Waiting for you' : running ? 'Working' : 'Ready'}
          </span>
        </div>
        <ModelPicker />
        <button
          type="button"
          className="ib talk-btn"
          aria-label="Talk"
          title={settings?.hasVoiceKey ? 'Talk' : 'Talk (add a Gemini key in Settings first)'}
          onClick={() => {
            void startCall()
          }}
        >
          <VoiceIcon name="handset" size={22} />
        </button>
      </div>

      <div
        className="thread"
        ref={thread}
        onScroll={() => {
          const el = thread.current
          if (!el) return
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 56
        }}
      >
        {!loaded ? (
          <div className="thread-in">
            <Skeleton rows={5} />
          </div>
        ) : messages.length === 0 ? (
          <div className="thread-in">
            <EmptyState
              mascot={settings?.mascot ?? 'scout'}
              title={`Say something to ${agentName}`}
              line="Ask a question, give it a job, or paste a link. Anything that spends money or changes a file asks first."
              action={
                <Button
                  variant="tonal"
                  size="sm"
                  onClick={() => {
                    composer.current?.focus()
                  }}
                >
                  Write the first message
                </Button>
              }
            />
          </div>
        ) : (
          <div className="thread-in">
            {segments.map((segment, index) =>
              segment.kind === 'tools' ? (
                <ToolSteps key={segment.id} items={segment.items} live={running && index === segments.length - 1} />
              ) : (
                <div key={segment.item.id} style={{ display: 'contents' }}>
                  {renderItem(segment.item, items, (row) => setReader(row), agentName)}
                </div>
              ),
            )}
            {thinking ? (
              <div className="a-msg think" role="status" aria-live="polite">
                <Mascot id={settings?.mascot ?? 'scout'} size={30} busy />
                <div className="typing" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
                <span className="think-label">{agentName} is thinking</span>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="compose">
        {attachProblem !== '' ? (
          <div className="banner warn attach-warn" role="alert">
            {attachProblem}
          </div>
        ) : null}
        {attachments.length > 0 ? (
          <div className="attach-row">
            {attachments.map((file) => (
              <AttachmentChip
                key={file.path}
                file={file}
                onRemove={() => {
                  setAttachments((current) => current.filter((item) => item.path !== file.path))
                }}
              />
            ))}
          </div>
        ) : null}
        <div className="compose-in">
          <IconButton
            icon="clip"
            label="Attach a file"
            onClick={() => {
              void pickFiles()
            }}
          />
          <IconButton icon="shot" label="Grab a screenshot" comingSoon className="hide-m" />
          <textarea
            ref={composer}
            rows={1}
            placeholder="Ask anything"
            aria-label="Message"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send()
              }
            }}
          />
          <DictateButton
            hasKey={settings?.hasVoiceKey === true}
            onText={(words) => {
              setText((current) => (current.trim() === '' ? words : `${current.replace(/\s+$/, '')} ${words}`))
              composer.current?.focus()
            }}
            onProblem={(message, action) => {
              if (action === undefined) setAttachProblem(message)
              else toast(message, { actionLabel: action.label, onAction: action.run })
            }}
          />
          {running ? (
            <button
              type="button"
              className="send"
              aria-label="Stop"
              onClick={() => {
                void chat.stop()
              }}
            >
              <Icon name="stop" size={22} />
            </button>
          ) : (
            <button
              type="button"
              className="send"
              onClick={send}
              aria-label="Send"
              disabled={text.trim() === '' && attachments.length === 0}
            >
              <Icon name="arrow" size={22} />
            </button>
          )}
        </div>
        <div className="cfoot">
          <span>
            <Kbd>Enter</Kbd> send
          </span>
          <span>
            <Kbd>Shift</Kbd> <Kbd>Enter</Kbd> new line
          </span>
          <span>
            <Kbd>Ctrl</Kbd> <Kbd>V</Kbd> paste an image
          </span>
        </div>
      </div>

      {report !== null && reader !== null ? (
        <Dialog label={report.title} onClose={() => setReader(null)}>
          <div className="reader-top">
            <span className="eyebrow">REPORT</span>
            <span className="small muted">
              {report.words} {report.words === 1 ? 'word' : 'words'}
            </span>
          </div>
          <h2 className="h2">{report.title}</h2>
          <div className="reader">
            <Markdown text={report.markdown} />
          </div>
          <div className="dialog-actions">
            <Button onClick={() => setReader(null)}>Close</Button>
          </div>
        </Dialog>
      ) : null}

      <CallSheet />

      {dragging ? (
        <div className="drop" role="status" aria-live="polite">
          <span className="drop-i">
            <Icon name="clip" size={28} />
          </span>
          <div className="drop-t">Drop to attach</div>
          <div className="drop-s">Images show as thumbnails. Files up to 20 MB.</div>
        </div>
      ) : null}
    </div>
  )
}
