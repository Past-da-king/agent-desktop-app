import { MAIN_CHAT } from '@agent/core'

export const APP_PAGES = [
  'home',
  'chat',
  'tasks',
  'memory',
  'routines',
  'apps',
  'connections',
  'settings',
] as const

export type AppPage = (typeof APP_PAGES)[number]

export const ONBOARDING_STEPS = ['signin', 'sync', 'ai', 'style'] as const

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

export type Route =
  /** `chat` is the chat on screen for the chat page (absent: the one already open); other pages ignore it. */
  | { page: AppPage; chat?: string }
  | { page: 'onboarding'; step: OnboardingStep }
  | { page: 'quick-window' }
  | { page: 'dictation' }
  /** One project: its chats and its memory. */
  | { page: 'project'; id: string }
  /** One mini-app, open in the sheet (docs/plans/mini-apps.md). */
  | { page: 'miniapp'; id: string }

export function isAppPage(value: string): value is AppPage {
  return (APP_PAGES as readonly string[]).includes(value)
}

export function isOnboardingStep(value: string): value is OnboardingStep {
  return (ONBOARDING_STEPS as readonly string[]).includes(value)
}

/** Chat ids the address may carry (the main process and the renderer both make letters, digits, - and _). */
const CHAT_ID = /^[A-Za-z0-9_-]{1,64}$/

/** `#/home`, `#/chat/pc1a2b`, `#/onboarding/sync`. An empty or unknown hash returns null so boot can choose. */
export function parseHash(hash: string): Route | null {
  const raw = hash.replace(/^#\/?/, '').replace(/\/$/, '')
  if (raw === '') return null
  const [first, second] = raw.split('/')
  if (first === 'onboarding') {
    return { page: 'onboarding', step: second && isOnboardingStep(second) ? second : 'signin' }
  }
  if (first === 'quick-window') return { page: 'quick-window' }
  if (first === 'dictation') return { page: 'dictation' }
  if (first === 'chat' && second !== undefined && CHAT_ID.test(second)) return { page: 'chat', chat: second }
  if (first === 'project' && second !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(second)) return { page: 'project', id: second }
  if (first === 'app' && second !== undefined && /^[a-z0-9]{1,40}$/.test(second)) return { page: 'miniapp', id: second }
  if (first && isAppPage(first)) return { page: first }
  return null
}

export function hashFor(route: Route): string {
  if (route.page === 'onboarding') return `#/onboarding/${route.step}`
  if (route.page === 'quick-window') return '#/quick-window'
  if (route.page === 'dictation') return '#/dictation'
  if (route.page === 'project') return `#/project/${route.id}`
  if (route.page === 'miniapp') return `#/app/${route.id}`
  // The main chat is plain `#/chat`; any other chat names itself, so Back and a reload land in the same chat.
  if (route.page === 'chat' && route.chat !== undefined && route.chat !== MAIN_CHAT && CHAT_ID.test(route.chat)) return `#/chat/${route.chat}`
  return `#/${route.page}`
}

const LAST_KEY = 'agent.lastView'

export function rememberLastView(page: AppPage): void {
  try {
    window.localStorage.setItem(LAST_KEY, page)
  } catch {
    // Remembering the last view is a convenience; private mode can refuse storage.
  }
}

export function lastView(): AppPage {
  try {
    const raw = window.localStorage.getItem(LAST_KEY)
    if (raw && isAppPage(raw)) return raw
  } catch {
    // Fall through to home.
  }
  return 'home'
}
