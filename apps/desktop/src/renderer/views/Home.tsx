import type { ChatItem, TaskRow, TriggerRow } from '@agent/core'
import { useMemo } from 'react'

import { agent, chat } from '../bridge'
import { openCards } from '../lib/cards'
import { dueLabel, greeting, nextRun, scheduleLabel, short, todayEyebrow } from '../lib/format'
import { metaStrings, metaText, parseMeta } from '../lib/meta'
import { useEntity, useEntityLoaded } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import { Mascot } from '../ui/Mascot'
import { Ring } from '../ui/Ring'
import { SectionHeader } from '../ui/SectionHeader'
import { Skeleton } from '../ui/Skeleton'
import { Wave } from '../ui/Wave'

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

function whenLabel(upcoming: Upcoming): string {
  if (upcoming.routine) {
    return scheduleLabel({ kind: 'at', spec: new Date(upcoming.when).toISOString() })
  }
  return dueLabel({ dueAt: upcoming.when })
}

function QuestionCard({ item, agentName }: { item: ChatItem; agentName: string }): JSX.Element {
  const meta = parseMeta(item.meta)
  const options = metaStrings(meta, 'options')
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
          Show me more
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

export function Home(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const navigate = useUi((state) => state.navigate)
  const openPalette = useUi((state) => state.openPalette)
  const focusComposer = useUi((state) => state.focusComposer)
  const selectTask = useUi((state) => state.selectTask)
  const setTaskTab = useUi((state) => state.setTaskTab)

  const chat = useEntity('chat_item')
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

  const needs = openCards(chat)
  const question = needs.find((item) => item.kind === 'question')
  const approvals = needs.filter((item) => item.kind === 'approval')
  const openGoal = goals.find((goal) => goal.status === 'open')
  const goalTasks = openGoal ? tasks.filter((task) => task.goalId === openGoal.id) : []
  const doneSteps = goalTasks.filter((task) => task.status === 'done').length
  const userTasks = useMemo(
    () =>
      tasks
        .filter((task) => task.owner === 'user')
        .sort((a, b) => {
          if (a.dueAt === null && b.dueAt === null) return a.createdAt - b.createdAt
          if (a.dueAt === null) return 1
          if (b.dueAt === null) return -1
          return a.dueAt - b.dueAt
        }),
    [tasks],
  )
  const openTodos = userTasks.filter((task) => task.status !== 'done').length
  const nextItems = upcoming(tasks, triggers)

  const toggleTask = (task: TaskRow): void => {
    void agent.data.upsert('task', { ...task, status: task.status === 'done' ? 'todo' : 'done' })
  }

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
              navigate({ page: 'chat' })
              focusComposer()
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
              <Mascot id={settings?.mascot ?? 'scout'} size={84} busy={needs.length === 0} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="eyebrow">RIGHT NOW</div>
                <div className="nm">{agentName}</div>
                <div className="sub">
                  {needs.length > 0
                    ? `Waiting for you on ${needs.length === 1 ? 'one thing' : `${needs.length} things`}`
                    : openGoal
                      ? `Working on ${openGoal.title}`
                      : 'Nothing on your plate yet'}
                </div>
              </div>
              <Icon name="arrow" size={26} />
            </div>
            {openGoal ? (
              <div>
                <div className="eyebrow" style={{ marginBottom: 8 }}>
                  WORKING ON
                </div>
                <div className="now-row">
                  <span>{openGoal.title}</span>
                  <span className="num">
                    {doneSteps}/{goalTasks.length}
                  </span>
                </div>
                <div style={{ margin: '12px 0 14px' }}>
                  <Wave pct={goalTasks.length === 0 ? 0 : (doneSteps / goalTasks.length) * 100} />
                </div>
                <div className="stepchips">
                  {goalTasks.slice(0, 5).map((step) => (
                    <span className="sc-chip" key={step.id}>
                      {step.status === 'done' ? <Icon name="check" size={14} /> : null}
                      {step.status === 'blocked' ? <Icon name="clock" size={14} /> : null}
                      {short(step.title, 48)}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <div className="sub">Tell me what you would like done and I will start on it.</div>
            )}
          </button>

          <section>
            <SectionHeader
              eyebrow="YOUR TO-DOS"
              line={`${openTodos} open, soonest first`}
              right={
                <Button variant="text" size="sm" onClick={() => navigate({ page: 'tasks' })}>
                  All
                </Button>
              }
            />
            {userTasks.length === 0 ? (
              <EmptyState
                mascot={settings?.mascot ?? 'scout'}
                title="Nothing on your list"
                line="Tell me what you would like done and I will keep it here for you."
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
                {userTasks.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    className={`todo${task.status === 'done' ? ' done' : ''}`}
                    onClick={() => toggleTask(task)}
                    aria-label={`${task.status === 'done' ? 'Mark not done' : 'Mark done'}: ${task.title}`}
                  >
                    <span className="cb" aria-hidden="true">
                      {task.status === 'done' ? <Icon name="check" size={16} /> : null}
                    </span>
                    <span className="todo-body">
                      <div className="tt">{task.title}</div>
                      <div className={`dd${task.dueAt !== null && task.dueAt - Date.now() < 86_400_000 ? ' soon' : ''}`}>
                        {dueLabel(task)}
                      </div>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section>
            <SectionHeader eyebrow="GOALS" line="What your agent is working through" />
            {goals.filter((goal) => goal.status === 'open').length === 0 ? (
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
                  .filter((goal) => goal.status === 'open')
                  .map((goal) => {
                    const steps = tasks.filter((task) => task.goalId === goal.id)
                    const done = steps.filter((task) => task.status === 'done').length
                    return (
                      <button
                        key={goal.id}
                        type="button"
                        className="goal"
                        onClick={() => {
                          setTaskTab('agent')
                          navigate({ page: 'tasks' })
                        }}
                      >
                        <div className="top">
                          <Ring pct={steps.length === 0 ? 0 : (done / steps.length) * 100} />
                          <span className="fr num">
                            {done}/{steps.length}
                          </span>
                        </div>
                        <div className="gt">{goal.title}</div>
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
              {needs.length === 0 ? (
                <div className="need done">
                  <div className="eyebrow">
                    <Icon name="check" size={14} />
                    NOTHING NEEDS YOU
                  </div>
                  <div className="q">You are all clear.</div>
                  <div className="small muted">I will keep going and tell you when something needs a decision.</div>
                </div>
              ) : null}
              {question ? <QuestionCard item={question} agentName={agentName} /> : null}
              {approvals.map((item) => (
                <ApprovalCard key={item.id} item={item} />
              ))}
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
            <ul className="list mach">
              <li>
                <span className="mi">
                  <Icon name="monitor" size={20} />
                </span>
                <div style={{ flex: 1 }}>
                  <div className="t1" style={{ font: "500 14px/1.3 'Roboto',sans-serif" }}>
                    This computer
                  </div>
                  <div className="small muted">{settings?.deviceName || 'Ready for work'}</div>
                </div>
                <span className="pill ok">Online</span>
              </li>
              <li title="Coming soon">
                <span className="mi">
                  <Icon name="server" size={20} />
                </span>
                <div style={{ flex: 1 }}>
                  <div className="t1" style={{ font: "500 14px/1.3 'Roboto',sans-serif" }}>
                    Another machine
                  </div>
                  <div className="small muted">Hand heavy work to your own servers later.</div>
                </div>
                <span className="pill mute">Coming soon</span>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}
