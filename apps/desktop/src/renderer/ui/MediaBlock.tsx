/**
 * A picture, a video or a sound the agent shows in the chat, played inside the app instead of sent out to another
 * program. The main process (main/tools/media.ts) serves a local file from an opaque address, agent-media://f/<token>,
 * with no path in it; a web picture is a plain https address.
 *
 * One component for the chat row, the generated cards (OpenUI) and an image written in prose, so all three look the
 * same: the app's own card surface, tokens only, a real player with its own controls, and a lightbox for a picture.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Icon } from './Icon'

export type MediaKind = 'video' | 'image' | 'audio'

const TOKEN = /^agent-media:\/\/f\/[0-9a-f]{32}$/
const WEB = /^https:\/\/[^\s"'<>]+$/i

/** What may be drawn: an address the main process made (agent-media://f/<32 hex>), or a plain https picture or file. */
export function mediaSrcOk(src: string): boolean {
  const s = typeof src === 'string' ? src.trim() : ''
  return TOKEN.test(s) || WEB.test(s)
}

export interface MediaBlockProps {
  kind: MediaKind
  src: string
  /** One short line under it, or empty. */
  caption?: string
  /** The file's name: the picture's alt, the close label, and what a dead card names. */
  name?: string
  className?: string
}

/**
 * The picture large, over the whole window: a dark scrim, the picture contained, a close button top right.
 * Escape closes, a click on the scrim closes, focus goes to the close button and comes back to where it was.
 */
export function ImageLightbox({ src, name, onClose }: { src: string; name?: string | undefined; onClose: () => void }): JSX.Element {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const backTo = useRef<Element | null>(null)
  useEffect(() => {
    backTo.current = document.activeElement
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      const back = backTo.current
      if (back instanceof HTMLElement && back.isConnected) back.focus()
    }
  }, [onClose])
  const label = name !== undefined && name.trim() !== '' ? name.trim() : 'Picture'
  return createPortal(
    <div className="mb-light" role="dialog" aria-modal="true" aria-label={label} onClick={onClose}>
      <button ref={closeRef} type="button" className="mb-light-x" aria-label="Close picture" onClick={onClose}>
        <Icon name="x" size={20} />
      </button>
      {/* A click on the picture itself is not a click on the scrim. */}
      <img className="mb-light-img" src={src} alt={label} onClick={(event) => event.stopPropagation()} />
    </div>,
    document.body,
  )
}

/** A picture, a video or a sound from the agent, drawn in the chat or in a card. */
export function MediaBlock({ kind, src, caption, name, className }: MediaBlockProps): JSX.Element {
  const [failed, setFailed] = useState(false)
  const [zoom, setZoom] = useState(false)
  const clean = typeof src === 'string' ? src.trim() : ''
  const named = name !== undefined ? name.trim() : ''
  const line = caption !== undefined ? caption.trim() : ''
  const extra = className !== undefined && className.trim() !== '' ? ` ${className.trim()}` : ''

  // Never render an address that is not the token the main process made, or a web one.
  if (!mediaSrcOk(clean)) {
    return <p className={`mb-note${extra}`}>This file cannot be shown here</p>
  }
  // A file that went away reads as a quiet line, never as a broken player.
  if (failed) {
    return <p className={`mb-note${extra}`}>This file is not available any more{named !== '' ? `: ${named}` : ''}</p>
  }

  const dead = (): void => setFailed(true)

  return (
    <figure className={`mb${extra}`}>
      {kind === 'video' ? (
        <video className="mb-video" src={clean} controls preload="metadata" playsInline onError={dead} />
      ) : kind === 'audio' ? (
        <div className="mb-audio-row">
          <audio className="mb-audio" src={clean} controls preload="metadata" onError={dead} />
          {named !== '' ? <span className="mb-name">{named}</span> : null}
        </div>
      ) : (
        <>
          <button
            type="button"
            className="mb-pic"
            aria-label={named !== '' ? `Enlarge ${named}` : 'Enlarge picture'}
            onClick={() => setZoom(true)}
          >
            <img className="mb-img" src={clean} alt={named} loading="lazy" referrerPolicy="no-referrer" onError={dead} />
          </button>
          {zoom ? <ImageLightbox src={clean} name={named} onClose={() => setZoom(false)} /> : null}
        </>
      )}
      {line !== '' ? <figcaption className="mb-cap">{line}</figcaption> : null}
    </figure>
  )
}
