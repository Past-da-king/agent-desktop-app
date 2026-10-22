import { VoiceNote } from '../voice/VoiceNote'
import { PROFILE_COLORS, fileSizeLabel, type Attachment, type ChatItem, type ProfileColor, type ProjectIcon } from '@agent/core'
import { Suspense, createContext, lazy, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react'

import { agent, chat } from '../bridge'
import { openCards } from '../lib/cards'
import { attachmentsFromMeta, isImageFile } from '../lib/files'
import { helperView, type HelperView } from '../lib/helpers'
import { isDivider, threadItems, threadTitle } from '../lib/thread'
import { branchFrom, startProjectChat } from '../lib/chat-actions'
import { projectOfChat, viaIcon, viaOf } from '../lib/projects'
import { ProjectTile } from '../ui/ProjectTile'
import { chatTitleOf, isSideRun, itemsOfChat, routeLine } from '../lib/chats'
import { MAIN_CHAT } from '@agent/core'
import { startChatTracking, useChatRunning, useChats } from '../state/useChats'
import { CopyButton } from '../ui/CopyButton'
import { metaStrings, metaText, parseMeta } from '../lib/meta'
import { plainPreview, reportText } from '../lib/report'
import { chatPlaces } from '../lib/chat-place'
import { PlaceChip } from '../ui/PlaceChip'
import { useEntity, useEntityLoaded } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { useWaiting } from '../state/useWaiting'
import { toast } from '../state/useToast'
import { CallRow } from '../voice/CallRow'
import { useCall } from '../voice/useCall'
import { VisualCard, visualFromMeta } from '../voice/VisualCard'
import { VoiceIcon } from '../voice/VoiceIcon'
import { Button } from '../ui/Button'
import { IconButton, Pill } from '../ui/bits'
import { Chip } from '../ui/Chip'
import { Dialog } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { Icon, type IconName } from '../ui/Icon'
import { Markdown } from '../ui/Markdown'
import { AgentMessage, AskCard, ProjectAskCard } from '../openui/AgentMessage'
import type { ProjectAsk } from '../openui/ask'
import { ReportBody } from '../openui/ReportBody'
import { useNarrow } from '../shell/Panel'
import { usePanel } from '../state/usePanel'
import { withNo } from '../../shared/ask-options'
import { isIconImage } from '../../shared/project-icon'
import { ModelPicker } from '../ui/ModelPicker'
import { Mascot } from '../ui/Mascot'
import { Skeleton } from '../ui/Skeleton'
import { runFromMeta, snippetOf } from '../../shared/run-record'
import { RunStep } from './RunStep'
import { ChatDivider, EarlierChats } from './ChatDivider'
import { THREAD_STEP, THREAD_WINDOW, visibleThread, windowThread } from '../lib/chat-memory'
import { Composer, type ComposerHandle } from './Composer'
import { useThumbnail } from './AttachmentChip'

const CallSheet = lazy(() => import('../voice/CallSheet').then((m) => ({ default: m.CallSheet })))

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

function MessageAttachment({ file }: { file: Attachment }): JSX.Element {
  const src = useThumbnail(file)
  if (isImageFile(file) && src !== null) {
    return (
      <div className="u-file pic" title={file.path}>
        <img src={src} alt={file.name} />
        <span>{file.name}</span>
      </div>
    )
  }
  return (
    <div className="u-file plain" title={file.path}>
      <Icon name={file.mime === 'inode/directory' ? 'folder' : 'file'} size={18} />
      <span>{file.name}</span>
      {file.size !== undefined ? <span className="u-file-size">{fileSizeLabel(file.size)}</span> : null}
    </div>
  )
}

function ActivityRow({ item }: { item: ChatItem }): JSX.Element {
  const meta = parseMeta(item.meta)
  const tool = metaText(meta, 'tool')
  const status = metaText(meta, 'status') || 'done'
  const summary = metaText(meta, 'summary') || item.text
  // A command, program or file step shows what it actually ran, and opens to the full record.
  const run = runFromMeta(meta)
  if (run !== null) return <RunStep run={run} status={status} by={metaText(meta, 'by') || undefined} summary={summary} rowId={item.id} />
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

/** An approval the person already answered: history, so it folds in with the tool steps. */
function decidedApproval(item: ChatItem): boolean {
  if (item.kind !== 'approval') return false
  const decision = metaText(parseMeta(item.meta), 'decision')
  return decision === 'approve' || decision === 'decline'
}

/** A step for the folded row: a tool step, or an answered approval. */
function isStep(item: ChatItem): boolean {
  return item.kind === 'activity' || decidedApproval(item)
}

/** Back-to-back tool steps (and answered approvals) become ONE row: the live step while it runs, then a summary. */
function segmentsOf(messages: ChatItem[]): Segment[] {
  const out: Segment[] = []
  for (const item of messages) {
    const last = out[out.length - 1]
    if (isStep(item) && last !== undefined && last.kind === 'tools') last.items.push(item)
    else if (isStep(item)) out.push({ kind: 'tools', id: item.id, items: [item] })
    else out.push({ kind: 'item', item })
  }
  return out
}

/** One answered approval, as a small line. */
function ApprovalLine({ item }: { item: ChatItem }): JSX.Element {
  const meta = parseMeta(item.meta)
  const approved = metaText(meta, 'decision') === 'approve'
  return (
    <div className={`appr-line${approved ? '' : ' no'}`}>
      <i>
        <Icon name={approved ? 'check' : 'x'} size={14} />
      </i>
      <span>
        <b>{approved ? 'Approved' : 'Declined'}</b> {metaText(meta, 'summary') || item.text}
      </span>
    </div>
  )
}

function StepRow({ item }: { item: ChatItem }): JSX.Element {
  return item.kind === 'approval' ? <ApprovalLine item={item} /> : <ActivityRow item={item} />
}

const ToolSteps = memo(function ToolSteps({ items, live }: { items: ChatItem[]; live: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  const statuses = items.map((item) => (item.kind === 'approval' ? 'done' : metaText(parseMeta(item.meta), 'status') || 'done'))
  const running = live && statuses.includes('running')
  // A command that ran but exited non-zero failed too, even though the tool itself worked.
  const failed = items.filter(
    (item, index) => statuses[index] === 'error' || runFromMeta(parseMeta(item.meta))?.state === 'failed',
  ).length
  const approvals = items.filter((item) => item.kind === 'approval')
  const tools = items.length - approvals.length
  const approvedCount = approvals.filter((item) => metaText(parseMeta(item.meta), 'decision') === 'approve').length
  const declined = approvals.length - approvedCount
  const parts = [
    tools > 0 ? `Used ${tools} ${tools === 1 ? 'tool' : 'tools'}` : '',
    approvedCount > 0 ? `${approvedCount} approved` : '',
    declined > 0 ? `${declined} declined` : '',
    failed > 0 ? `${failed} failed` : '',
  ].filter((part) => part !== '')
  // The folded line still shows a snippet of what was run: a failed run first, else the last command or program.
  const runs = items.map((item) => runFromMeta(parseMeta(item.meta))).filter((run) => run !== null).reverse()
  const lastRun = runs.find((run) => run.state === 'failed') ?? runs.find((run) => run.kind === 'shell' || run.kind === 'code') ?? runs[0] ?? null
  const current = [...items].reverse().find((_, index) => statuses[items.length - 1 - index] === 'running') ?? items[items.length - 1]
  if (running && current !== undefined) {
    return (
      <div className="tool-live">
        <StepRow item={current} />
        {items.length > 1 ? <span className="tool-count">Step {items.length}</span> : null}
      </div>
    )
  }
  if (items.length === 1 && items[0] !== undefined) return <StepRow item={items[0]} />
  return (
    <div className="tool-group">
      <button type="button" className="tool-sum-row" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <i>
          <Icon name={failed > 0 ? 'x' : 'check'} size={16} />
        </i>
        <span>{parts.join(', ')}</span>
        {lastRun !== null ? <code className="run-snip in-sum">{snippetOf(lastRun.input)}</code> : null}
        <Icon name={open ? 'chevd' : 'chev'} size={16} />
      </button>
      {open ? (
        <div className="tool-list">
          {items.map((item) => (
            <StepRow key={item.id} item={item} />
          ))}
        </div>
      ) : null}
    </div>
  )
}, (a, b) => a.live === b.live && a.items.length === b.items.length && a.items.every((row, i) => sameItem(row, b.items[i] as ChatItem)))

/** True while the side panel shows its list of what needs the person (it is on screen and not taken by a report or helper). */
function useSidebarWaiting(): boolean {
  const narrow = useNarrow()
  const panel = usePanel((store) => !store.collapsed && store.report === null && store.helper === null)
  return panel && !narrow
}

/**
 * An approval or question still waiting: it is answered in the side panel, so the chat keeps one line pointing
 * there. When the panel is not on screen the whole card is here instead, so nothing can be missed.
 */
function Waiting({ item, full }: { item: ChatItem; full: JSX.Element }): JSX.Element {
  const inSidebar = useSidebarWaiting()
  const meta = parseMeta(item.meta)
  const pending = item.kind === 'approval' ? metaText(meta, 'decision') === '' : !(typeof meta['answer'] === 'string' && meta['answer'] !== '')
  if (!pending || !inSidebar) return full
  const what = item.kind === 'approval' ? metaText(meta, 'summary') || item.text : item.text
  return (
    <button
      type="button"
      className="wait-line"
      title="Show it in the side panel"
      onClick={() => {
        // Brings the card into view in the side panel and points it out.
        const card = document.querySelector<HTMLElement>(`.ny-card[data-item="${item.id}"]`)
        if (card === null) return
        card.scrollIntoView({ block: 'center' })
        card.classList.remove('ny-flash')
        void card.offsetWidth
        card.classList.add('ny-flash')
      }}
    >
      <i>
        <Icon name={item.kind === 'approval' ? 'shield' : 'person'} size={14} />
      </i>
      <span>
        <b>{item.kind === 'approval' ? 'Waiting for your approval' : 'Waiting for your answer'}</b> {what}
      </span>
      <span className="wait-where">
        Answer it in the side panel <Icon name="chev" size={14} />
      </span>
    </button>
  )
}

/** The project a question card asks to make, when it is one (main/tools/projects.ts project_create). */
function projectAskOf(meta: Record<string, unknown>): { ask: ProjectAsk; icon: ProjectIcon } | null {
  const card = meta['card']
  if (typeof card !== 'object' || card === null || Array.isArray(card)) return null
  const c = card as Record<string, unknown>
  if (c['kind'] !== 'project' || typeof c['name'] !== 'string') return null
  const icon = typeof c['icon'] === 'object' && c['icon'] !== null ? (c['icon'] as Record<string, unknown>) : {}
  const color = typeof icon['color'] === 'string' && (PROFILE_COLORS as readonly string[]).includes(icon['color']) ? (icon['color'] as ProfileColor) : 'iris'
  return {
    ask: {
      name: c['name'],
      description: typeof c['description'] === 'string' ? c['description'] : '',
      path: typeof c['path'] === 'string' ? c['path'] : '',
      folderNew: c['folderNew'] === true,
      profile: typeof c['profile'] === 'string' ? c['profile'] : 'General',
    },
    icon: { glyph: typeof icon['glyph'] === 'string' ? icon['glyph'] : 'folder', color, ...(isIconImage(icon['image']) ? { image: icon['image'] } : {}) },
  }
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
          {withNo(options).includes('No') && !options.includes('No') ? (
            <button type="button" className="ans" disabled={sending} onClick={() => answer('No')}>
              No
            </button>
          ) : null}
        </div>
        <div className="hint">The page is yours while this card is open. Finish the step, then carry on.</div>
      </div>
    )
  }

  // A project the agent wants to make (project_create): the card shows it, and Create makes it.
  const project = projectAskOf(meta)
  return (
    <div className="appr ask">
      {project !== null ? (
        <ProjectAskCard project={project.ask} icon={<ProjectTile icon={project.icon} size={48} />} options={options} disabled={sending} onPick={answer} />
      ) : (
        /* An OpenUI ask card as on the phone: one button per answer, and always a No. */
        <AskCard question={item.text} options={options.length > 0 ? options : ['Yes']} disabled={sending} onPick={answer} />
      )}
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
  const computer = meta['scope'] === 'computer'
  const save = useSettings((state) => state.save)
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
        {computer ? (
          <button
            type="button"
            className="ans"
            disabled={sending}
            onClick={() => {
              if (sending) return
              setSending(true)
              // Settings, Commands and files: Run without asking. The main process then lets this card and any
              // other waiting command, code or file card go ahead. Connected apps and anything sent still ask.
              void save({ shell: 'always' }).catch(() => setSending(false))
            }}
          >
            Always allow on this computer
          </button>
        ) : null}
        <button type="button" className="ans" disabled={sending} onClick={() => decide('decline')}>
          Decline
        </button>
      </div>
      <div className="hint">
        {computer
          ? 'Always allow covers commands, code and files on this computer. Connected apps and anything sent in your name still ask. Change it in Settings.'
          : 'Nothing happens until you approve.'}
      </div>
    </div>
  )
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

/** Whether messages on screen can be branched: in a project chat yes, in the main thread no. */
const Branchable = createContext(false)

/** Copy, and in a project chat Branch from here, under a message. */
function MessageActions({ item, align }: { item: ChatItem; align: 'start' | 'end' }): JSX.Element {
  const [branching, setBranching] = useState(false)
  const branchable = useContext(Branchable)
  return (
    <div className={`msg-acts ${align}`}>
      {item.text.trim() !== '' ? <CopyButton text={item.text} /> : null}
      {branchable ? (
      <button
        type="button"
        className="copy-btn"
        disabled={branching}
        title="A new chat with everything up to here. This chat stays as it is."
        onClick={() => {
          setBranching(true)
          void branchFrom(item.id).finally(() => setBranching(false))
        }}
      >
        <Icon name="branch" size={16} />
        <span>{branching ? 'Branching' : 'Branch from here'}</span>
      </button>
      ) : null}
    </div>
  )
}

function UserRow({ item }: { item: ChatItem }): JSX.Element {
  const files = attachmentsFromMeta(parseMeta(item.meta)['attachments'])
  const route = routeLine(item)
  const pending = parseMeta(item.meta)['route'] === 'pending'
  // A message from another chat (the main agent, or a project chat) says who sent it.
  const via = viaOf(item)
  return (
    <div className={`u-row${via === null ? '' : ' via'}`}>
      {via === null ? null : (
        <div className="u-via">
          <Icon name={viaIcon(via)} size={14} />
          {via.line}
        </div>
      )}
      {item.text !== '' ? <div className="u-msg">{item.text}</div> : null}
      {files.length > 0 ? (
        <div className="u-files">
          {files.map((file) => (
            <MessageAttachment key={`${file.path}-${file.name}`} file={file} />
          ))}
        </div>
      ) : null}
      {route !== '' ? (
        <div className={`u-route${pending ? ' pending' : ''}`} role="status">
          <Icon name={pending ? 'clock' : parseMeta(item.meta)['route'] === 'join' ? 'check' : 'branch'} size={14} />
          {route}
        </div>
      ) : null}
      <MessageActions item={item} align="end" />
    </div>
  )
}

/**
 * A different job sent while the chat was busy, done as its own run. While it works it shows its latest step;
 * when it is done it shows a short summary, and opens to the full transcript (what was asked, every step, the
 * whole result).
 */
function SideRunRow({ helper, asked }: { helper: HelperView; asked: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const live = helper.state === 'working'
  const done = helper.state === 'done'
  const label = live ? (helper.queued ? 'Waiting its turn' : 'Working') : done ? 'Done' : helper.state === 'failed' ? 'Failed' : 'Stopped'
  const tone = live ? 'pri' : done ? 'ok' : 'warn'
  const result = helper.result.trim()
  const lines = result.split('\n').filter((line) => line.trim() !== '')
  const preview = lines.slice(0, 4).join('\n')
  const bodyId = `side-${helper.id.replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <section className={`side-run ${helper.state}`} aria-label={`Separate job: ${asked || helper.label}`}>
      <div className="side-top">
        <span className={`side-i${live ? ' work' : ''}`}>
          <Icon name={live ? 'branch' : done ? 'check' : helper.state === 'failed' ? 'x' : 'stop'} size={18} />
        </span>
        <div className="side-head">
          <span className="eyebrow">{live ? 'RUNNING ALONGSIDE' : 'DONE ALONGSIDE'}</span>
          <b>{asked === '' ? helper.label : asked}</b>
        </div>
        <Pill tone={tone}>{label}</Pill>
      </div>
      {live ? (
        <div className="side-now">{helper.summary || 'Thinking'}</div>
      ) : result !== '' ? (
        <div className="side-sum">
          <Markdown text={open || lines.length <= 4 ? result : `${preview}...`} />
        </div>
      ) : (
        <div className="side-now">{helper.summary || label}</div>
      )}
      <div className="side-acts">
        <button type="button" className="copy-btn" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((value) => !value)}>
          <Icon name={open ? 'chevd' : 'chev'} size={16} />
          <span>{open ? 'Hide what it did' : `Show what it did (${helper.activity.length} ${helper.activity.length === 1 ? 'step' : 'steps'})`}</span>
        </button>
        {result !== '' && !live ? <CopyButton text={result} label="Copy summary" /> : null}
        {live ? (
          <button
            type="button"
            className="copy-btn"
            disabled={stopping}
            onClick={() => {
              setStopping(true)
              void agent.helpers.stop(helper.id).catch(() => setStopping(false))
            }}
          >
            <Icon name="stop" size={16} />
            <span>Stop this job</span>
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="side-body" id={bodyId}>
          <div className="side-label">What it was asked</div>
          <div className="hbrief">{asked === '' ? helper.brief : asked}</div>
          <div className="side-label">Steps</div>
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
    </section>
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

/** One row of the thread. Memoised: a new row elsewhere in the chat leaves this one alone. */
const Row = memo(function Row({
  item,
  agentName,
  onOpenReport,
  helper,
  asked,
}: {
  item: ChatItem
  agentName: string
  onOpenReport: (item: ChatItem) => void
  /** For a helper row: its live view, worked out by the thread. */
  helper?: HelperView | undefined
  /** For a side run: the message that asked for it. */
  asked: string
}): JSX.Element {
  switch (item.kind) {
    case 'user':
      return <UserRow item={item} />
    case 'agent': {
      // A visual a voice call put on screen keeps its own card; everything else is text plus OpenUI cards.
      const visual = visualFromMeta(parseMeta(item.meta))
      return visual === null ? (
        <div className="a-msg-wrap">
          <AgentMessage item={item} />
          <MessageActions item={item} align="start" />
        </div>
      ) : (
        <div className="a-msg">
          <VisualCard visual={visual} compact />
        </div>
      )
    }
    case 'call':
      return <CallRow item={item} agentName={agentName} />
    case 'voice_note':
      return <VoiceNote item={item} agentName={agentName} />
    case 'activity':
      return <ActivityRow item={item} />
    case 'question':
      return <Waiting item={item} full={<QuestionRow item={item} />} />
    case 'approval':
      return <Waiting item={item} full={<ApprovalRow item={item} />} />
    case 'helper':
      if (helper === undefined) return <div className="from">{item.text}</div>
      if (isSideRun(item)) return <SideRunRow helper={helper} asked={asked} />
      return <HelperRow helper={helper} />
    case 'report':
      return <ReportRow item={item} onOpen={onOpenReport} />
    case 'notice':
      if (isDivider(item)) return <ChatDivider item={item} />
      return (
        <div className="from">
          <Icon name={parseMeta(item.meta)['from'] === 'phone' ? 'phone' : 'bell'} size={14} />
          {item.text}
        </div>
      )
    default:
      return <div className="from">{item.text}</div>
  }
}, sameRow)

/** Rows arrive as fresh objects from the main process: the same row is one whose content did not change. */
function sameItem(a: ChatItem, b: ChatItem): boolean {
  return a === b || (a.id === b.id && a.text === b.text && a.meta === b.meta && a.kind === b.kind && a.createdAt === b.createdAt)
}

function sameRow(a: { item: ChatItem; agentName: string; onOpenReport: unknown; helper?: HelperView | undefined; asked: string }, b: typeof a): boolean {
  return sameItem(a.item, b.item) && a.agentName === b.agentName && a.onOpenReport === b.onOpenReport && a.asked === b.asked && sameHelper(a.helper, b.helper)
}

function sameHelper(a: HelperView | undefined, b: HelperView | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return a.id === b.id && a.state === b.state && a.summary === b.summary && a.result === b.result && a.queued === b.queued && a.activity.length === b.activity.length && a.activity.every((row, i) => sameItem(row, b.activity[i] as ChatItem))
}

/** Above the window: more of this stretch, then the earlier stretches of this chat. */
function EarlierRows({ above, earlier, onMore, onEarlier }: { above: number; earlier: number; onMore: () => void; onEarlier: () => void }): JSX.Element | null {
  if (above > 0) {
    return (
      <div className="earlier-chats">
        <button type="button" className="chip" onClick={onMore}>
          <Icon name="chevd" size={16} />
          Show earlier ({above} more)
        </button>
      </div>
    )
  }
  return <EarlierChats count={earlier} onShow={onEarlier} />
}

export function Chat(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const allItems = useEntity('chat_item')
  const loaded = useEntityLoaded('chat_item')
  const scrollToken = useUi((state) => state.chatScroll)
  const openChat = useChats((state) => state.open)
  const markSeen = useChats((state) => state.markSeen)
  const allWaiting = useWaiting()
  const [dragging, setDragging] = useState(false)
  const running = useChatRunning(openChat)
  const [reader, setReader] = useState<ChatItem | null>(null)
  const openReport = usePanel((store) => store.openReport)
  const narrow = useNarrow()
  const thread = useRef<HTMLDivElement>(null)
  const composer = useRef<ComposerHandle>(null)
  const stuck = useRef(true)
  /** Something new arrived below while the person was reading further up. */
  const [below, setBelow] = useState(false)
  const dragDepth = useRef(0)

  const [showEarlier, setShowEarlier] = useState(false)
  // Only the newest rows are drawn; Show earlier widens the window in steps, keeping the place on screen.
  const [drawn, setDrawn] = useState(THREAD_WINDOW)
  const keepPlace = useRef<number | null>(null)
  // Only this chat's rows: every other chat keeps running on its own and shows in the rail.
  const items = useMemo(() => itemsOfChat(allItems, openChat), [allItems, openChat])
  const all = useMemo(
    () => [...threadItems(items), ...items.filter(isSideRun)].sort((a, b) => a.createdAt - b.createdAt),
    [items],
  )
  // New chat clears the screen: older stretches of this chat stay in the history, one tap away (views/ChatDivider.tsx).
  const stretch = useMemo(() => visibleThread(all, showEarlier), [all, showEarlier])
  const shown = useMemo(() => windowThread(stretch.rows, drawn), [stretch.rows, drawn])
  const messages = shown.rows
  // Helper rows need the whole chat (their steps and results live in other rows); worked out once per change.
  const helperViews = useMemo(() => {
    const views = new Map<string, HelperView>()
    for (const item of items) if (item.kind === 'helper') views.set(item.id, helperView(item, items))
    return views
  }, [items])
  const segments = useMemo(() => segmentsOf(messages), [messages])
  // The same name the rail shows for it.
  const title = chatTitleOf(items)
  const cards = openCards(items, true)
  const chatIds = useMemo(() => new Set(items.map((item) => item.id)), [items])
  const waiting = allWaiting.filter((item) => chatIds.has(item.id))
  const needsYou = waiting.length > 0 || cards.length > 0
  const agentName = settings?.agentName.trim() || 'Your agent'
  const startCall = useCall((state) => state.start)
  const projects = useEntity('project')
  const jobs = useEntity('job')
  const deviceRows = useEntity('device')
  const placedOn = useMemo(() => chatPlaces(jobs, deviceRows).get(openChat) ?? '', [jobs, deviceRows, openChat])
  // The main thread is the one main agent; a project chat is that agent at work in one project.
  const project = projectOfChat(projects, openChat)
  const navigate = useUi((state) => state.navigate)

  useEffect(() => startChatTracking(), [])

  useEffect(() => {
    // The browser preview can open straight into a call (?demo=1&call=1), so the call view can be screenshotted.
    if (agent.platform === 'web' && agent.remote === undefined && new URLSearchParams(window.location.search).get('call') === '1') void startCall()
  }, [startCall])


  // Opening a chat (or reading the one on screen) marks it read, and starts at its newest message.
  useEffect(() => {
    setShowEarlier(false)
    setDrawn(THREAD_WINDOW)
  }, [openChat, scrollToken])

  // Opening a chat starts at its newest message.
  useEffect(() => {
    stuck.current = true
    setBelow(false)
    const el = thread.current
    if (el) el.scrollTop = el.scrollHeight
  }, [openChat])

  useEffect(() => {
    markSeen(openChat)
  }, [openChat, items.length, markSeen])

  // New rows (a helper's step, a reply) follow the newest message only while the person is at the bottom. Reading
  // further up, they stay where they are and a button says there is something new below.
  const newest = items.length === 0 ? '' : `${items.length}:${items[items.length - 1]?.id ?? ''}`
  useEffect(() => {
    const el = thread.current
    if (el === null) return
    if (stuck.current) el.scrollTop = el.scrollHeight
  }, [items, running, loaded])
  useEffect(() => {
    if (!stuck.current && newest !== '') setBelow(true)
  }, [newest])

  useEffect(() => {
    if (scrollToken === 0) return
    setShowEarlier(false)
    stuck.current = true
    const timer = window.setTimeout(() => {
      const el = thread.current
      if (el) el.scrollTop = el.scrollHeight
    }, 0)
    return () => window.clearTimeout(timer)
  }, [scrollToken])

  // Just before a message goes: follow it to the bottom.
  const onSend = useCallback((): void => {
    stuck.current = true
  }, [])

  // A stretch widened with Show earlier keeps what was on screen where it was.
  useLayoutEffect(() => {
    const el = thread.current
    const saved = keepPlace.current
    if (el === null || saved === null) return
    keepPlace.current = null
    el.scrollTop = el.scrollHeight - saved
  }, [drawn, showEarlier])

  const report = reader === null ? null : reportText(reader)
  // A window made too narrow for the side panel moves an open report into the dialog.
  const panelReport = usePanel((store) => store.report)
  const closeReport = usePanel((store) => store.closeReport)
  useEffect(() => {
    if (!narrow || panelReport === null) return
    const row = allItems.find((item) => item.id === panelReport)
    closeReport()
    if (row !== undefined) setReader(row)
  }, [narrow, panelReport, allItems, closeReport])
  // Beside the chat in the side panel; a window too narrow for the panel reads it in a dialog instead.
  const openReader = useCallback(
    (row: ChatItem): void => {
      if (narrow) setReader(row)
      else openReport(row.id)
    },
    [narrow, openReport],
  )
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
    composer.current?.takeFiles(dropped)
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
          {project === null ? (
            <b>{agentName}</b>
          ) : (
            <button type="button" className="chat-proj" onClick={() => navigate({ page: 'project', id: project.id })} title={`Open ${project.name}`}>
              <ProjectTile icon={project.icon} size={18} />
              <span>{project.name}</span>
              <Icon name="chev" size={14} />
            </button>
          )}
          <span className={`chat-sub${needsYou ? ' warn' : ''}`}>
            {project === null ? '' : `${title} · `}
            {needsYou ? 'Waiting for you' : running ? 'Working' : 'Ready'}
            <PlaceChip name={placedOn} />
          </span>
        </div>
        {project === null ? null : (
          <IconButton
            icon="plus"
            label={`New chat in ${project.name}`}
            size={20}
            onClick={() => {
              void startProjectChat(project)
            }}
          />
        )}
        <ModelPicker chat={openChat} project={project} />
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
          if (stuck.current) setBelow(false)
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
              line="Ask a question, give it a job, or paste a link, a screenshot or a file. Anything that spends money or changes a file asks first."
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
          <Branchable.Provider value={project !== null}>
          <div className="thread-in">
            <EarlierRows
              above={shown.above}
              earlier={stretch.earlier}
              onMore={() => {
                keepPlace.current = thread.current === null ? null : thread.current.scrollHeight - thread.current.scrollTop
                setDrawn((now) => now + THREAD_STEP)
              }}
              onEarlier={() => {
                keepPlace.current = thread.current === null ? null : thread.current.scrollHeight - thread.current.scrollTop
                setShowEarlier(true)
                setDrawn(Number.POSITIVE_INFINITY)
              }}
            />
            {segments.map((segment, index) =>
              segment.kind === 'tools' ? (
                <ToolSteps key={segment.id} items={segment.items} live={running && index === segments.length - 1} />
              ) : (
                <Row
                  key={segment.item.id}
                  item={segment.item}
                  agentName={agentName}
                  onOpenReport={openReader}
                  helper={helperViews.get(segment.item.id)}
                  asked={segment.item.kind === 'helper' ? (items.find((row) => row.id === metaText(parseMeta(segment.item.meta), 'ask'))?.text ?? '') : ''}
                />
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
          </Branchable.Provider>
        )}
      </div>

      <div className="compose">
        {below ? (
          <button
            type="button"
            className="new-below"
            onClick={() => {
              const el = thread.current
              if (el) el.scrollTop = el.scrollHeight
              stuck.current = true
              setBelow(false)
            }}
          >
            <Icon name="chevd" size={16} />
            New below
          </button>
        ) : null}
        <Composer ref={composer} chatId={openChat} onSend={onSend} />
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
            <ReportBody markdown={report.markdown} />
          </div>
          <div className="dialog-actions">
            <CopyButton text={report.markdown} label="Copy report" />
            <Button onClick={() => setReader(null)}>Close</Button>
          </div>
        </Dialog>
      ) : null}

      <Suspense fallback={null}>
        <CallSheet />
      </Suspense>

      {dragging ? (
        <div className="drop" role="status" aria-live="polite">
          <span className="drop-i">
            <Icon name="clip" size={28} />
          </span>
          <div className="drop-t">Drop to attach</div>
          <div className="drop-s">Pictures, documents, code, zips, anything up to 20 MB.</div>
        </div>
      ) : null}
    </div>
  )
}
