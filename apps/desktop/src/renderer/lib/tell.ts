/**
 * Runs something the person asked for and tells them when it fails. A click that asks the main process for
 * something must never fail silently: the promise is caught here and the reason goes in a toast.
 */
import { toast } from '../state/useToast'

/** The error's own words when it has any, else the fallback. */
export function failText(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim() !== '') return cause.message
  if (typeof cause === 'string' && cause.trim() !== '') return cause
  return fallback
}

/** Resolves to the value, or to undefined after telling the person what went wrong. Never rejects. */
export async function orTell<T>(work: Promise<T> | (() => Promise<T>), fallback: string, tell: (line: string) => void = toast): Promise<T | undefined> {
  try {
    return await (typeof work === 'function' ? work() : work)
  } catch (cause: unknown) {
    tell(failText(cause, fallback))
    return undefined
  }
}
