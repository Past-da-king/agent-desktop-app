import type { MemoryKind, TaskRow, TriggerRow } from '@agent/core'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function greeting(date = new Date()): string {
  const hour = date.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export function todayEyebrow(date = new Date()): string {
  return date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase()
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function dayLabel(ms: number): string {
  const date = new Date(ms)
  const now = new Date()
  const startOf = (value: Date): number => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((startOf(date) - startOf(now)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'
  if (days > 1 && days < 7) return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`
}

export function dueLabel(task: Pick<TaskRow, 'dueAt'>): string {
  if (task.dueAt === null) return 'No date'
  const date = new Date(task.dueAt)
  const label = dayLabel(task.dueAt)
  const hours = date.getHours()
  const minutes = date.getMinutes()
  const withTime = hours !== 0 || minutes !== 0
  return withTime ? `${label}, ${clock(task.dueAt)}` : label
}

export function timeAgo(ms: number | null): string {
  if (ms === null) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} min`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h`
  if (diff < 2 * 86_400_000) return 'Yesterday'
  return WEEKDAYS[new Date(ms).getDay()] ?? ''
}

/** The next moment a routine should run, or null when it is off. */
export function nextRun(trigger: Pick<TriggerRow, 'kind' | 'spec' | 'enabled' | 'lastRunAt'>): number | null {
  if (!trigger.enabled) return null
  if (trigger.kind === 'interval') {
    const minutes = Number(trigger.spec)
    if (!Number.isFinite(minutes)) return null
    return (trigger.lastRunAt ?? Date.now()) + minutes * 60_000
  }
  if (trigger.kind === 'at') {
    const at = new Date(trigger.spec).getTime()
    return Number.isNaN(at) ? null : at
  }
  const [hour, minute] = trigger.spec.split(':').map(Number)
  const next = new Date()
  next.setHours(hour ?? 7, minute ?? 0, 0, 0)
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1)
  return next.getTime()
}

export function scheduleLabel(trigger: Pick<TriggerRow, 'kind' | 'spec'>): string {
  if (trigger.kind === 'daily') return `Every day at ${trigger.spec}`
  if (trigger.kind === 'interval') {
    const minutes = Number(trigger.spec)
    return Number.isFinite(minutes) ? `Every ${minutes} minutes` : `Every ${trigger.spec} minutes`
  }
  const date = new Date(trigger.spec)
  if (Number.isNaN(date.getTime())) return trigger.spec
  return `${WEEKDAYS[date.getDay()]} at ${clock(date.getTime())}`
}

const KIND_LABELS: Record<MemoryKind, string> = {
  fact: 'Fact',
  preference: 'Preference',
  person: 'Person',
  decision: 'Decision',
  'how-to': 'How-to',
  event: 'Event',
  skill: 'Skill',
}

export function kindLabel(kind: MemoryKind): string {
  return KIND_LABELS[kind]
}

export function short(text: string, max = 64): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean
}
