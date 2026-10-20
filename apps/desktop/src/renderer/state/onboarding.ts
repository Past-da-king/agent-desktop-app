/**
 * Small pieces of onboarding state that must survive a reload but are not preferences:
 * which step the person reached, whether they chose this computer only, and a one-shot
 * welcome flag for Home. sessionStorage is right for all three: they are per-window and
 * should not follow the account to another computer.
 */
import { isOnboardingStep, type OnboardingStep } from './route'

const STEP_KEY = 'agent.onboardingStep'
const LOCAL_KEY = 'agent.onboardingLocalOnly'
const WELCOME_KEY = 'agent.welcome'

function read(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value)
  } catch {
    // A locked-down browser can refuse storage; the hash still carries the step.
  }
}

function remove(key: string): void {
  try {
    window.sessionStorage.removeItem(key)
  } catch {
    // Nothing to clear.
  }
}

export function rememberStep(step: OnboardingStep): void {
  write(STEP_KEY, step)
}

export function savedStep(): OnboardingStep | null {
  const value = read(STEP_KEY)
  return value !== null && isOnboardingStep(value) ? value : null
}

export function clearStep(): void {
  remove(STEP_KEY)
}

export function rememberLocalOnly(): void {
  write(LOCAL_KEY, '1')
}

export function isLocalOnly(): boolean {
  return read(LOCAL_KEY) === '1'
}

export function clearLocalOnly(): void {
  remove(LOCAL_KEY)
}

export function markWelcome(): void {
  write(WELCOME_KEY, '1')
}

/** Reads and clears the flag, so the wave plays once. */
export function takeWelcome(): boolean {
  const value = read(WELCOME_KEY) === '1'
  if (value) remove(WELCOME_KEY)
  return value
}
