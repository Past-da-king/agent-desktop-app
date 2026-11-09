import { useSyncExternalStore } from 'react'

/** Whether the window matches a media query right now, e.g. `(max-width:1180px)`. Follows the window as it resizes. */
export function useNarrow(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const media = window.matchMedia(query)
      media.addEventListener('change', listener)
      return () => media.removeEventListener('change', listener)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}
