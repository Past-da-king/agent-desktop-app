import type { ProjectIcon } from '@agent/core'
import type { CSSProperties } from 'react'

import { isIconImage } from '../../shared/project-icon'
import { toneStyle } from '../lib/profiles'
import { Icon, hasIcon } from './Icon'

/** A project's icon, like an app icon: its own picture, or its glyph or emoji on a rounded tile in its colour. */
export function ProjectTile({ icon, size = 44, status }: { icon: ProjectIcon; size?: number; status?: 'working' | 'waiting' | null }): JSX.Element {
  const glyph = icon.glyph.trim()
  return (
    <span className="pf pj-tile" style={{ ...(toneStyle(icon.color) as CSSProperties), width: size, height: size, borderRadius: Math.round(size * 0.28) }} aria-hidden="true">
      {isIconImage(icon.image) ? (
        <img className="pj-img" src={icon.image} alt="" draggable={false} />
      ) : hasIcon(glyph) ? (
        <Icon name={glyph} size={Math.round(size * 0.5)} />
      ) : (
        <span className="pj-emoji" style={{ fontSize: Math.round(size * 0.52) }}>{glyph || '?'}</span>
      )}
      {status === 'working' || status === 'waiting' ? <i className={`pj-dot ${status}`} /> : null}
    </span>
  )
}
