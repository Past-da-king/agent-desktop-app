/**
 * Small pieces of onboarding state that must survive a reload before settings do.
 * The current step already lives in the route hash; these cover the draft form and the
 * "this computer only" choice, which only exists for this onboarding session.
 */

const DRAFT_KEY = 'agent.ob.signin'
const LOCAL_ONLY_KEY = 'agent.ob.localOnly'

export interface SignInDraft {
  mode: 'in' | 'new'
  email: string
  serverUrl: string
}

export function readSignInDraft(): SignInDraft | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const source = parsed as Record<string, unknown>
    return {
      mode: source['mode'] === 'new' ? 'new' : 'in',
      email: typeof source['email'] === 'string' ? source['email'] : '',
      serverUrl: typeof source['serverUrl'] === 'string' ? source['serverUrl'] : '',
    }
  } catch {
    return null
  }
}

export function writeSignInDraft(draft: SignInDraft): void {
  try {
    window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  } catch {
    // A reload losing the draft is a small inconvenience, not a failure.
  }
}

export function markLocalOnly(): void {
  try {
    window.sessionStorage.setItem(LOCAL_ONLY_KEY, '1')
  } catch {
    // No session storage means the sync step shows its fresh state instead.
  }
}

export function isLocalOnly(): boolean {
  try {
    return window.sessionStorage.getItem(LOCAL_ONLY_KEY) === '1'
  } catch {
    return false
  }
}

export function clearLocalOnly(): void {
  try {
    window.sessionStorage.removeItem(LOCAL_ONLY_KEY)
  } catch {
    // Nothing to clear.
  }
}
