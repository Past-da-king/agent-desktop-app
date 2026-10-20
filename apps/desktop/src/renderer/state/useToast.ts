import { create } from 'zustand'

export interface Toast {
  id: number
  message: string
  actionLabel?: string
  onAction?: () => void
}

interface ToastState {
  toasts: Toast[]
  push: (message: string, options?: { actionLabel?: string; onAction?: () => void }) => number
  dismiss: (id: number) => void
}

const LIFETIME = 7000
const timers = new Map<number, ReturnType<typeof setTimeout>>()
let nextId = 1

function clearTimer(id: number): void {
  const timer = timers.get(id)
  if (timer !== undefined) clearTimeout(timer)
  timers.delete(id)
}

export const useToast = create<ToastState>((set, get) => ({
  toasts: [],

  push: (message, options) => {
    const id = nextId
    nextId += 1
    const toast: Toast = {
      id,
      message,
      actionLabel: options?.actionLabel,
      onAction: options?.onAction,
    }
    set((state) => ({ toasts: [...state.toasts, toast] }))
    clearTimer(id)
    timers.set(
      id,
      setTimeout(() => {
        get().dismiss(id)
      }, LIFETIME),
    )
    return id
  },

  dismiss: (id) => {
    clearTimer(id)
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
  },
}))

/** A small message at the bottom of the window, with one optional action such as Undo. */
export function toast(message: string, options?: { actionLabel?: string; onAction?: () => void }): number {
  return useToast.getState().push(message, options)
}

/** Drop every toast without running its action. Used by tests and by a reset. */
export function clearToasts(): void {
  for (const id of timers.keys()) clearTimer(id)
  useToast.setState({ toasts: [] })
}
