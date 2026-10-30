import type { ChatItem, GoalRow, TaskRow, TriggerRow } from '@agent/core'
import { useMemo, useState } from 'react'

import { agent, chat } from '../bridge'
import { startNewChat } from '../lib/chat-actions'
import { dueLabel, greeting, nextRun, scheduleLabel, short, timeAgo, todayEyebrow } from '../lib/format'
import { workingHelpers } from '../lib/helpers'
import { metaStrings, metaText, parseMeta } from '../lib/meta'
import { dueSoon, openUserTasks } from '../lib/tasks'
import { useCalmEntity, useEntity, useEntityLoaded } from '../state/useData'
import { useRunInfo, lastAgentWork } from '../state/useRun'
import { useSettings } from '../state/useSettings'
import { toast } from '../state/useToast'
import { useUi } from '../state/useUi'
import { useWaiting } from '../state/useWaiting'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import { Mascot } from '../ui/Mascot'
import { Ring } from '../ui/Ring'
import { SectionHeader } from '../ui/SectionHeader'
import { Skeleton } from '../ui/Skeleton'
import { Wave } from '../ui/Wave'
import { Machines } from './Machines'
import { TaskDialog } from './TaskDialog'
import { FailingWorkers, useFailingCount } from './Workers'
import { withNo } from '../../shared/ask-options'

/** Home shows the soonest few; the Tasks view holds the whole list. */
const HOME_TODOS = 6

interface Upcoming {
  id: string
  title: string
  when: number
  routine: boolean
}

function upcoming(tasks: TaskRow[], triggers: TriggerRow[]): Upcoming[] {
  const fromTasks: Upcoming[] = tasks
    .filter((task) => task.status !== 'done' && task.dueAt !== null && task.dueAt > Date.now() - 86_400_000)
    .map((task) => ({ id: task.id, title: task.title, when: task.dueAt ?? 0, routine: false }))
  const fromTriggers: Upcoming[] = triggers
    .map((trigger) => ({ trigger, when: nextRun(trigger) }))
    .filter((item): item is { trigger: TriggerRow; when: number } => item.when !== null)
    .map((item) => ({ id: item.trigger.id, title: item.trigger.name, when: item.when, routine: true }))
  return [...fromTasks, ...fromTriggers].sort((a, b) => a.when - b.when).slice(0, 5)
}

function whenLabel(item: Upcoming): string {
  if (item.routine) return scheduleLabel({ kind: 'at', spec: new Date(item.when).toISOString() })
  return dueLabel({ dueAt: item.when })
}

function goalProgress(goal: GoalRow | null, tasks: TaskRow[]): { steps: TaskRow[]; done: number; pct: number } {
  const steps = goal === null ? [] : tasks.filter((task) => task.goalId === goal.id)
  const done = steps.filter((task) => task.status === 'done').length
  return { steps, done, pct: steps.length === 0 ? 0 : (done / steps.length) * 100 }
}

function QuestionCard({ item, agentName }: { item: ChatItem; agentName: string }): JSX.Element {
  const meta = parseMeta(item.meta)
  // Always a way to say no, last, as in the chat (shared/ask-options).
  const options = withNo(metaStrings(meta, 'options'))
  const navigate = useUi((state) => state.navigate)

  return (
    <div className="need">
      <div className="eyebrow">
        <Icon name="bolt" size={14} />
        QUESTION
      </div>
      <div className="q">{item.text}</div>
      <div className="chips">
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
        <button type="button" className="ans" onClick={() => navigate({ page: 'chat' })}>
          Open in chat
        </button>
      </div>
      <div className="small muted" style={{ color: 'color-mix(in srgb, var(--on-tc) 82%, transparent)' }}>
        {agentName} waits for your pick before going further.
      </div>
    </div>
  )
}

function ApprovalCard({ item }: { item: ChatItem }): JSX.Element {
  const navigate = useUi((state) => state.navigate)
  return (
    <div className="need">
      <div className="eyebrow">
        <Icon name="shield" size={14} />
        APPROVE BEFORE I DO THIS
      </div>
      <div className="q">{metaText(parseMeta(item.meta), 'summary') || item.text}</div>
      <div className="chips">
        <Button
          style={{ height: 44 }}
          onClick={() => {
            void chat.decide(item.id, 'approve')
          }}
        >
          Approve
        </Button>
        <button type="button" className="ans" onClick={() => navigate({ page: 'chat' })}>
          Review details
        </button>
      </div>
    </div>
  )
}

function AddTodoInline(): JSX.Element {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const add = async (): Promise<void> => {
    const title = value.trim()
    if (title === '' || busy) return
    setBusy(true)
    const now = Date.now()
    try {
      await agent.data.upsert('task', {
        id: '',
        createdAt: now,
        goalId: null,
        title,
        notes: '',
        status: 'todo',
        dueAt: null,
        owner: 'user',
        blocker: '',
        updatedAt: now,
      })
      setValue('')
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'Could not add that to-do.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="todo-add"
      onSubmit={(event) => {
        event.preventDefault()
        void add()
      }}
    >
      <Icon name="plus" size={18} />
      <input
        aria-label="Add a to-do"
        placeholder="Add a to-do"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        autoComplete="off"
      />
      <Button type="submit" variant="tonal" size="sm" disabled={value.trim() === '' || busy}>
        Add
      </Button>
    </form>
  )
}

export function Home(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const navigate = useUi((state) => state.navigate)
  const openPalette = useUi((state) => state.openPalette)
  const focusComposer = useUi((state) => state.focusComposer)
  const setTaskTab = useUi((state) => state.setTaskTab)
  const [editingTask, setEditingTask] = useState<TaskRow | null>(null)

  const chatItems = useCalmEntity('chat_item')
  const tasks = useEntity('task')
  const goals = useEntity('goal')
  const triggers = useEntity('trigger')
  const chatLoaded = useEntityLoaded('chat_item')
  const tasksLoaded = useEntityLoaded('task')
  const goalsLoaded = useEntityLoaded('goal')
  const triggersLoaded = useEntityLoaded('trigger')
  const ready = chatLoaded && tasksLoaded && goalsLoaded && triggersLoaded

  const agentName = settings?.agentName.trim() || 'Your agent'
  const firstName = (settings?.userName.trim() || 'there').split(' ')[0] ?? 'there'

  const needs = useWaiting()
  const failingWorkers = useFailingCount()
  const helpers = useMemo(() => workingHelpers(chatItems), [chatItems])
  const openGoal = goals.find((goal) => goal.status === 'open') ?? null
  const goal = goalProgress(openGoal, tasks)
  const run = useRunInfo(chatItems)
  const lastWork = lastAgentWork(chatItems)

  const todos = useMemo(() => openUserTasks(tasks), [tasks])
  const nextItems = upcoming(tasks, triggers)

  const toggleTask = (task: TaskRow): void => {
    void agent.data.upsert('task', { ...task, status: task.status === 'done' ? 'todo' : 'done' }).catch((cause: unknown) => {
      toast(cause instanceof Error ? cause.message : 'Could not change that to-do.')
    })
  }

  const deleteTask = (task: TaskRow): void => {
    setEditingTask(null)
    void agent.data
      .remove('task', task.id)
      .then(() => {
        toast('To-do deleted.', {
          actionLabel: 'Undo',
          onAction: () => {
            void agent.data.upsert('task', task)
          },
        })
      })
      .catch((cause: unknown) => {
        toast(cause instanceof Error ? cause.message : 'Could not delete that to-do.')
      })
  }

  const heroSubtitle = run.running
    ? 'Working right now'
    : needs.length > 0
      ? `Waiting for you on ${needs.length === 1 ? 'one thing' : `${needs.length} things`}`
      : helpers.length > 0
        ? `${helpers.length === 1 ? 'A helper is' : `${helpers.length} helpers are`} working on it`
        : openGoal
          ? `Working on ${openGoal.title}`
          : lastWork
            ? `Last worked ${timeAgo(lastWork.createdAt)}`
            : 'Nothing on your plate yet'

  if (!ready) {
    return (
      <div className="page">
        <div className="ph">
          <div>
            <span className="eyebrow">{todayEyebrow()}</span>
            <h1 className="h1">
              {greeting()}, {firstName}.
            </h1>
          </div>
        </div>
        <div className="home">
          <div className="col-a">
            <Skeleton rows={5} />
            <Skeleton rows={4} />
          </div>
          <div className="col-b">
            <Skeleton rows={3} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="ph">
        <div>
          <span className="eyebrow">{todayEyebrow()}</span>
          <h1 className="h1">
            {greeting()}, {firstName}.
          </h1>
        </div>
        <div className="ph-actions">
          <Button variant="tonal" onClick={openPalette}>
            <Icon name="search" size={18} />
            Search
          </Button>
          <Button
            onClick={() => {
              void startNewChat()
            }}
          >
            <Icon name="plus" size={18} />
            New chat
          </Button>
        </div>
      </div>

      <div className="home">
        <div className="col-a">
          <button
            type="button"
            className="now"
            onClick={() => navigate({ page: 'chat' })}
            aria-label="Open the conversation"
          >
            <div className="now-top">
              <Mascot id={settings?.mascot ?? 'scout'} size={84} busy={needs.length === 0} needsYou={needs.length > 0} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="eyebrow">RIGHT NOW</div>
                <div className="nm">{agentName}</div>
                <div className="sub">{heroSubtitle}</div>
              </div>
              <Icon name="arrow" size={26} />
            </div>
            {helpers.length > 0 ? (
              <div>
                <div className="eyebrow" style={{ marginBottom: 8 }}>
                  HELPERS
                </div>
                <div className="now-helpers">
                  {helpers.map((helper) => (
                    <div className="now-helper" key={helper.id}>
                      <Icon name="globe" size={16} />
                      <b>{helper.label}</b>
                      <span>{helper.summary || (helper.queued ? 'Waiting its turn' : 'Working')}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {run.running ? (
              <div>
                <div className="eyebrow" style={{ marginBottom: 8 }}>
                  WORKING ON
                </div>
                <div className="now-row">
                  <span>{run.activity || 'Thinking it through'}</span>
                  {openGoal ? (
                    <span className="num">
                      {goal.done}/{goal.steps.length}
                    </span>
                  ) : null}
                </div>
                <div style={{ margin: '12px 0 14px' }}>
                  <Wave pct={openGoal ? goal.pct : 35} />
                </div>
                <div className="stepchips">
                  {(openGoal ? goal.steps : tasks.filter((task) => task.owner === 'agent')).slice(0, 5).map((step) => (
                    <span className="sc-chip" key={step.id}>
                      {step.status === 'done' ? <Icon name="check" size={14} /> : null}
                      {step.status === 'blocked' ? <Icon name="clock" size={14} /> : null}
                      <span>{short(step.title, 48)}</span>
                    </span>
                  ))}
                </div>
              </div>
            ) : openGoal ? (
              <div>
                <div className="eyebrow" style={{ marginBottom: 8 }}>
                  WORKING ON
                </div>
                <div className="now-row">
                  <span>{openGoal.title}</span>
                  <span className="num">
                    {goal.done}/{goal.steps.length}
                  </span>
                </div>
                <div style={{ margin: '12px 0 14px' }}>
                  <Wave pct={goal.pct} />
                </div>
                <div className="stepchips">
                  {goal.steps.slice(0, 5).map((step) => (
                    <span className="sc-chip" key={step.id}>
                      {step.status === 'done' ? <Icon name="check" size={14} /> : null}
                      {step.status === 'blocked' ? <Icon name="clock" size={14} /> : null}
                      <span>{short(step.title, 48)}</span>
                    </span>
                  ))}
                </div>
              </div>
            ) : lastWork ? (
              <div>
                <div className="eyebrow" style={{ marginBottom: 8 }}>
                  THE LAST THING I DID
                </div>
                <div className="now-row">
                  <span>{short(lastWork.text, 110)}</span>
                  <span className="num">{timeAgo(lastWork.createdAt)}</span>
                </div>
                <div style={{ margin: '12px 0 14px' }}>
                  <Wave pct={100} />
                </div>
              </div>
            ) : (
              <div className="sub">Tell me what you would like done and I will start on it.</div>
            )}
          </button>

          <section>
            <SectionHeader
              eyebrow="YOUR TO-DOS"
              line={todos.length === 0 ? 'Nothing open right now' : `${todos.length} open, soonest first`}
              right={
                <Button variant="text" size="sm" onClick={() => navigate({ page: 'tasks' })}>
                  All
                </Button>
              }
            />
            {todos.length === 0 ? (
              <EmptyState
                mascot={settings?.mascot ?? 'scout'}
                title="Nothing on your list"
                line="Tell me what you would like done, or add something small here now."
                action={
                  <Button
                    variant="tonal"
                    size="sm"
                    onClick={() => {
                      navigate({ page: 'chat' })
                      focusComposer()
                    }}
                  >
                    Tell me what you would like done
                  </Button>
                }
              />
            ) : (
              <div className="list">
                {todos.slice(0, HOME_TODOS).map((task) => (
                  <div key={task.id} className="todo">
                    <button
                      type="button"
                      className="cb"
                      role="checkbox"
                      aria-checked={false}
                      aria-label={`Mark done: ${task.title}`}
                      onClick={() => toggleTask(task)}
                    >
                      {task.status === 'done' ? <Icon name="check" size={16} /> : null}
                    </button>
                    <button
                      type="button"
                      className="todo-body"
                      style={{ flex: 1, minWidth: 0, textAlign: 'left' }}
                      onClick={() => setEditingTask(task)}
                    >
                      <div className="tt">{task.title}</div>
                      <div className={`dd${dueSoon(task) ? ' soon' : ''}`}>{dueLabel(task)}</div>
                    </button>
                    <button
                      type="button"
                      className="ib del"
                      aria-label={`Delete ${task.title}`}
                      onClick={() => deleteTask(task)}
                    >
                      <Icon name="trash" size={18} />
                    </button>
                  </div>
                ))}
                {todos.length > HOME_TODOS ? (
                  <button type="button" className="todo-more" onClick={() => navigate({ page: 'tasks' })}>
                    {todos.length - HOME_TODOS} more on your list
                    <Icon name="arrow" size={16} />
                  </button>
                ) : null}
              </div>
            )}
            <AddTodoInline />
          </section>

          <section>
            <SectionHeader eyebrow="GOALS" line="What your agent is working through" />
            {goals.filter((goalRow) => goalRow.status === 'open').length === 0 ? (
              <EmptyState
                mascot={settings?.mascot ?? 'scout'}
                title="No goals yet"
                line="A goal is a bigger thing you want your agent to work through over time."
                action={
                  <Button
                    variant="tonal"
                    size="sm"
                    onClick={() => {
                      navigate({ page: 'chat' })
                      focusComposer()
                    }}
                  >
                    Tell me a goal
                  </Button>
                }
              />
            ) : (
              <div className="goals">
                {goals
                  .filter((goalRow) => goalRow.status === 'open')
                  .map((goalRow) => {
                    const progress = goalProgress(goalRow, tasks)
                    return (
                      <button
                        key={goalRow.id}
                        type="button"
                        className="goal"
                        onClick={() => {
                          setTaskTab('agent')
                          navigate({ page: 'tasks' })
                        }}
                      >
                        <div className="top">
                          <Ring pct={progress.pct} />
                          <span className="fr num">
                            {progress.done}/{progress.steps.length}
                          </span>
                        </div>
                        <div className="gt">{goalRow.title}</div>
                      </button>
                    )
                  })}
              </div>
            )}
          </section>
        </div>

        <div className="col-b">
          <section>
            <SectionHeader eyebrow="NEEDS YOU" line="Your agent can't go on without these" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <FailingWorkers />
              {needs.length === 0 && failingWorkers > 0 ? null : needs.length === 0 ? (
                <div className="need done">
                  <div className="eyebrow">
                    <Icon name="check" size={14} />
                    NOTHING NEEDS YOU
                  </div>
                  <div className="q">You are all clear.</div>
                  <div className="small muted">I will keep going and tell you when something needs a decision.</div>
                </div>
              ) : (
                needs.map((item) =>
                  item.kind === 'question' ? (
                    <QuestionCard key={item.id} item={item} agentName={agentName} />
                  ) : (
                    <ApprovalCard key={item.id} item={item} />
                  ),
                )
              )}
            </div>
          </section>

          <section>
            <SectionHeader eyebrow="COMING UP" line="Routines and deadlines in the next few days" />
            <ul className="list up">
              {nextItems.length === 0 ? (
                <li>
                  <span className="ti">
                    <Icon name="clock" size={20} />
                  </span>
                  <div>
                    <div className="t1">Nothing scheduled</div>
                    <div className="t2">Routines and to-dos will show here.</div>
                  </div>
                </li>
              ) : (
                nextItems.map((item) => (
                  <li key={`${item.routine ? 'r' : 't'}-${item.id}`}>
                    <span className="ti">
                      <Icon name={item.routine ? 'clock' : 'cal'} size={20} />
                    </span>
                    <div>
                      <div className="t1">{item.title}</div>
                      <div className="t2">{whenLabel(item)}</div>
                    </div>
                  </li>
                ))
              )}
            </ul>
          </section>

          <section>
            <SectionHeader eyebrow="ON YOUR MACHINES" line="Where heavy work can run" />
            <Machines look="list" thisName="This computer" thisLine={settings?.deviceName || 'Ready for work'} />
          </section>
        </div>
      </div>

      {editingTask ? (
        <TaskDialog
          task={editingTask}
          owner="user"
          goals={goals}
          onClose={() => setEditingTask(null)}
          onSaved={() => undefined}
          onDelete={deleteTask}
        />
      ) : null}
    </div>
  )
}
