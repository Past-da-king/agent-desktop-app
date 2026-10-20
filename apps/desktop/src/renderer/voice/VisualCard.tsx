import type { CallVisual } from '@agent/core'
import { useState } from 'react'

/** Something the voice agent put on screen: a list, a picture or a small card. Same look in the call and the chat. */
export function VisualCard({
  visual,
  compact = false,
}: {
  visual: Pick<CallVisual, 'kind' | 'title' | 'items' | 'imageUrl' | 'body' | 'footnote'>
  compact?: boolean
}): JSX.Element {
  const [broken, setBroken] = useState(false)
  return (
    <figure className={`vcard kind-${visual.kind}${compact ? ' compact' : ''}`}>
      <figcaption className="vcard-t">
        <span className="eyebrow">{visual.kind === 'list' ? 'ON SCREEN' : visual.kind === 'image' ? 'PICTURE' : 'NOTE'}</span>
        <b>{visual.title}</b>
      </figcaption>
      {visual.kind === 'list' ? (
        <ol className="vcard-list">
          {(visual.items ?? []).map((item, index) => (
            <li key={`${index}-${item}`}>
              <span className="vcard-n">{index + 1}</span>
              <span>{item}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {visual.kind === 'image' && visual.imageUrl !== undefined ? (
        broken ? (
          <div className="vcard-broken">The picture could not load.</div>
        ) : (
          <img
            className="vcard-img"
            src={visual.imageUrl}
            alt={visual.title}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setBroken(true)}
          />
        )
      ) : null}
      {visual.kind === 'card' ? (
        <div className="vcard-body">
          <p>{visual.body}</p>
          {visual.footnote ? <small>{visual.footnote}</small> : null}
        </div>
      ) : null}
    </figure>
  )
}

/** A visual saved on a chat row, or null when the row has none or it is malformed. */
export function visualFromMeta(meta: Record<string, unknown>): CallVisual | null {
  const raw = meta['visual']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const kind = value['kind']
  const title = value['title']
  if ((kind !== 'list' && kind !== 'image' && kind !== 'card') || typeof title !== 'string') return null
  const items = Array.isArray(value['items']) ? value['items'].filter((item): item is string => typeof item === 'string') : undefined
  const pick = (key: string): string | undefined => (typeof value[key] === 'string' ? (value[key] as string) : undefined)
  const imageUrl = pick('imageUrl')
  const body = pick('body')
  const footnote = pick('footnote')
  return {
    id: '',
    at: 0,
    kind,
    title,
    ...(items === undefined ? {} : { items }),
    ...(imageUrl === undefined || !imageUrl.startsWith('https://') ? {} : { imageUrl }),
    ...(body === undefined ? {} : { body }),
    ...(footnote === undefined ? {} : { footnote }),
  }
}
