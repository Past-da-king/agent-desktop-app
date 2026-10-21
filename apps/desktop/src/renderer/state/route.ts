export const APP_PAGES = [
  'home',
  'chat',
  'tasks',
  'memory',
  'routines',
  'connections',
  'settings',
] as const

export type AppPage = (typeof APP_PAGES)[number]

export const ONBOARDING_STEPS = ['signin', 'sync', 'ai', 'style'] as const

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

export type Route =
  | { page: AppPage }
  | { page: 'onboarding'; step: OnboardingStep }
  | { page: 'quick-window' }
  | { page: 'dictation' }

export function isAppPage(value: string): value is AppPage {
  return (APP_PAGES as readonly string[]).includes(value)
}

export function isOnboardingStep(value: string): value is OnboardingStep {
  return (ONBOARDING_STEPS as readonly string[]).includes(value)
}

/** `#/home`, `#/onboarding/sync`. An empty or unknown hash returns null so boot can choose. */
export function parseHash(hash: string): Route | null {
  const raw = hash.replace(/^#\/?/, '').replace(/\/$/, '')
  if (raw === '') return null
  const [first, second] = raw.split('/')
  if (first === 'onboarding') {
    return { page: 'onboarding', step: second && isOnboardingStep(second) ? second : 'signin' }
  }
  if (first === 'quick-window') return { page: 'quick-window' }
  if (first === 'dictation') return { page: 'dictation' }
  if (first && isAppPage(first)) return { page: first }
  return null
}

export function hashFor(route: Route): string {
  if (route.page === 'onboarding') return `#/onboarding/${route.step}`
  if (route.page === 'quick-window') return '#/quick-window'
  if (route.page === 'dictation') return '#/dictation'
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
