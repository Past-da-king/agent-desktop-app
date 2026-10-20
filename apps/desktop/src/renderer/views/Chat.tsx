import { attachmentProblem, type Attachment, type ChatEvent, type ChatItem } from '@agent/core'
import { useEffect, useRef, useState, type DragEvent } from 'react'

import { agent, chat } from '../bridge'
import { attachmentsFromMeta, isImageFile } from '../lib/files'
import { openCards } from '../lib/cards'
import { short } from '../lib/format'
import { metaStrings, metaText, parseMeta } from '../lib/meta'
import { useEntity, useEntityLoaded, refreshEntity } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { IconButton, Kbd, Pill } from '../ui/bits'
import { Chip } from '../ui/Chip'
import { EmptyState } from '../ui/EmptyState'
import { Icon, type IconName } from '../ui/Icon'
import { Mascot } from '../ui/Mascot'
import { Markdown } from '../ui/Markdown'
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
}

function toolIcon(tool: string): IconName {
  return TOOL_ICONS[tool] ?? 'bolt'
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

function threadItems(items: ChatItem[]): ChatItem[] {
  return items
    .filter((item) => item.kind !== 'branch')
    .filter((item) => !(item.kind === 'question' && parseMeta(item.meta)['context'] === 'home'))
    .sort((a, b) => a.createdAt - b.createdAt)
}

function ActivityRow({ item }: { item: ChatItem }): JSX.Element {
  const meta = parseMeta(item.meta)
  const tool = metaText(meta, 'tool')
  const status = metaText(meta, 'status')
  const summary = metaText(meta, 'summary') || item.text
  return (
    <div className="tool">
      <i className={status === 'running' ? 'spin' : ''}>
        <Icon name={toolIcon(tool)} size={16} />
      </i>
      {summary}
    </div>
  )
}

function QuestionRow({ item }: { item: ChatItem }): JSX.Element {
  const meta = parseMeta(item.meta)
  const options = metaStrings(meta, 'options')
  const answered = typeof meta['answer'] === 'string' && meta['answer'] !== ''
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
  return (
    <div className="appr">
      <div className="eyebrow">
        <Icon name="bolt" size={14} />
        QUESTION
      </div>
      <div className="tt">{item.text}</div>
      <div className="acts">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className="ans"
            onClick={() => {
              void chat.answer(item.id, option)
            }}
          >
            {option}
          </button>
        ))}
      </div>
      <div className="hint">The run waits until you answer.</div>
    </div>
  )
}

function ApprovalRow({ item }: { item: ChatItem }): JSX.Element {
  const meta = parseMeta(item.meta)
  const decision = metaText(meta, 'decision')
  const summary = metaText(meta, 'summary') || item.text
  const details = metaText(meta, 'details')

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

  return (
    <div className="appr">
      <div className="eyebrow">
        <Icon name="shield" size={14} />
        APPROVE BEFORE I DO THIS
      </div>
      <div className="tt">{summary}</div>
      {details ? <pre>{details}</pre> : null}
      <div className="acts">
        <Button
          onClick={() => {
            void chat.decide(item.id, 'approve')
          }}
        >
          Approve and go ahead
        </Button>
        <button
          type="button"
          className="ans"
          onClick={() => {
            void chat.decide(item.id, 'decline')
          }}
        >
          Decline
        </button>
      </div>
      <div className="hint">Nothing happens until you approve.</div>
    </div>
  )
}

function ReportRow({ item }: { item: ChatItem }): JSX.Element {
  const meta = parseMeta(item.meta)
  return (
    <div className="card" style={{ background: 'var(--s-low)' }}>
      <span className="eyebrow">REPORT</span>
      <div className="h3" style={{ margin: '6px 0 8px' }}>
        {metaText(meta, 'title') || 'Report'}
      </div>
      <div style={{ fontSize: 15, lineHeight: 1.6 }}>
        <Markdown text={item.text} />
      </div>
    </div>
  )
}

function HelperRow({ item }: { item: ChatItem }): JSX.Element {
  const meta = parseMeta(item.meta)
  const status = metaText(meta, 'status') || 'done'
  return (
    <div className="hrow">
      <span className={`hs${status === 'working' ? ' work' : ''}`}>
        <Icon name={status === 'working' ? 'globe' : 'check'} size={20} />
      </span>
      <span className="hn">
        <b>{metaText(meta, 'name') || 'Helper'}</b>
        <Pill tone={status === 'working' ? 'pri' : 'ok'}>{status === 'working' ? 'Working' : 'Done'}</Pill>
        <div>{metaText(meta, 'summary') || item.text}</div>
      </span>
    </div>
  )
}

function UserRow({ item }: { item: ChatItem }): JSX.Element {
  const files = attachmentsFromMeta(parseMeta(item.meta)['attachments'])
  return (
    <div className="u-msg">
      {files.length > 0 ? (
        <div className="u-files">
          {files.map((file) => (
            <MessageAttachment key={`${file.path}-${file.name}`} file={file} />
          ))}
        </div>
      ) : null}
      {item.text}
    </div>
  )
}

function renderItem(item: ChatItem): JSX.Element {
  switch (item.kind) {
    case 'user':
      return <UserRow item={item} />
    case 'agent':
      return (
        <div className="a-msg">
          <Markdown text={item.text} />
        </div>
      )
    case 'activity':
      return <ActivityRow item={item} />
    case 'question':
      return <QuestionRow item={item} />
    case 'approval':
      return <ApprovalRow item={item} />
    case 'helper':
      return <HelperRow item={item} />
    case 'report':
      return <ReportRow item={item} />
    case 'notice':
      return (
        <div className="from">
          <Icon name="phone" size={14} />
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
  const navigate = useUi((state) => state.navigate)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attachProblem, setAttachProblem] = useState('')
  const [dragging, setDragging] = useState(false)
  const [running, setRunning] = useState(false)
  const thread = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const dragDepth = useRef(0)

  const messages = threadItems(items)
  const cards = openCards(items, true)
  const branches = items.filter((item) => item.kind === 'branch')
  const activeBranch = branches.find((item) => parseMeta(item.meta)['active'] === true) ?? branches[0]
  const branchMeta = activeBranch ? parseMeta(activeBranch.meta) : {}
  const firstUser = messages.find((item) => item.kind === 'user')
  const title = metaText(branchMeta, 'title') || (firstUser ? short(firstUser.text, 42) : 'New chat')
  const agentName = settings?.agentName.trim() || 'Your agent'
  const model = settings?.model.trim() || 'No model chosen'

  useEffect(() => {
    void chat.state().then((state) => setRunning(state.running))
  }, [])

  useEffect(() => {
    const off = chat.onEvent((event: ChatEvent) => {
      if (event.type === 'run_started') setRunning(true)
      if (event.type === 'run_finished') setRunning(false)
      if (event.type === 'chat_changed' || event.type === 'needs_you') refreshEntity('chat_item')
    })
    return off
  }, [])

  useEffect(() => {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight
  }, [messages.length, running, loaded])

  useEffect(() => {
    if (focusToken > 0) composer.current?.focus()
  }, [focusToken])

  useEffect(() => {
    const area = composer.current
    if (!area) return
    area.style.height = '48px'
    area.style.height = `${Math.min(area.scrollHeight, 140)}px`
  }, [text])

  const send = (): void => {
    const value = text.trim()
    if (value === '') return
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
        <Mascot id={settings?.mascot ?? 'scout'} size={40} busy={cards.length === 0} />
        <div className="ttl">
          <b>{title}</b>
          <span className={cards.length > 0 ? 'warn' : ''}>
            {cards.length > 0 ? 'Waiting for you' : running ? 'Working' : 'Ready'}
          </span>
        </div>
        <span className="model" title="Change the model in Settings">
          <Icon name="bolt" size={16} />
          <span>{model}</span>
          <Icon name="chevd" size={16} />
        </span>
        <IconButton icon="phone" label="Talk" comingSoon size={22} />
      </div>

      <div className="thread" ref={thread}>
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
            {messages.map((item) => (
              <div key={item.id} style={{ display: 'contents' }}>
                {renderItem(item)}
              </div>
            ))}
            {running ? (
              <div className="a-msg">
                <div className="typing" aria-label={`${agentName} is thinking`}>
                  <i />
                  <i />
                  <i />
                </div>
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
          <IconButton icon="mic" label="Dictate" comingSoon />
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
            <button type="button" className="send" onClick={send} aria-label="Send" disabled={text.trim() === ''}>
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

export function ChatPanel(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const navigate = useUi((state) => state.navigate)
  const selectMemory = useUi((state) => state.selectMemory)
  const memories = useEntity('memory')
  const used = [...memories].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt).slice(0, 3)
  const agentName = settings?.agentName.trim() || 'Your agent'

  return (
    <aside className="panel-w" aria-label="What your agent is doing">
      <section>
        <div className="panel-h">
          <div className="sec" style={{ margin: 0 }}>
            <span className="eyebrow">AGENT'S BROWSER</span>
            <span className="sec-line">Live, in its own window</span>
          </div>
          <Button variant="tonal" size="sm" comingSoon>
            Take over
          </Button>
        </div>
        <div className="browser" style={{ marginTop: 12 }}>
          <div className="br-top">
            <span className="url">
              <Icon name="lock" size={14} />
              Not open yet
            </span>
          </div>
          <div className="web">
            <div className="web-h">
              <b>Agent browser</b>
              <span style={{ color: '#55555e' }}>Waiting</span>
            </div>
            <div className="rt">{agentName} opens a real page here when a job needs the web.</div>
            <div className="fl">
              <b>Browser</b>
              <span>Separate session, separate cookies</span>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="sec">
          <span className="eyebrow">USED FROM MEMORY</span>
          <span className="sec-line">What I remembered for this</span>
        </div>
        {used.length === 0 ? (
          <div className="panel-empty">
            <Icon name="memory" size={18} />
            <span>Pages {agentName} uses in a chat will show here.</span>
          </div>
        ) : (
          <div className="mem-chips">
            {used.map((memory) => (
              <Chip
                key={memory.id}
                icon={<Icon name={memory.pinned ? 'heart' : 'memory'} size={16} />}
                onClick={() => {
                  selectMemory(memory.id)
                  navigate({ page: 'memory' })
                }}
              >
                {memory.title}
              </Chip>
            ))}
          </div>
        )}
      </section>
    </aside>
  )
}
