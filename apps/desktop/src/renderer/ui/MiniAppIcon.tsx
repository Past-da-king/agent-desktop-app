import { createElement } from 'react'

import { parseIconSvg } from '../../shared/miniapps'
import { Icon, hasIcon } from './Icon'

/**
 * A mini-app's icon: a name from the app's own icon set, or the small SVG an agent drew, reduced to plain shapes in
 * currentColor (shared/miniapps.ts parseIconSvg), so it takes the rail's colours in light, dark and every accent.
 */
export function MiniAppIcon({ icon, size = 22 }: { icon: string; size?: number }): JSX.Element {
  const value = icon.trim()
  if (hasIcon(value)) return <Icon name={value} size={size} />
  const parsed = value.startsWith('<') ? parseIconSvg(value) : null
  if (parsed === null || !parsed.ok) return <Icon name="grid" size={size} />
  return (
    <svg className="ico" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {parsed.nodes.map((node, index) => createElement(node.tag, { key: index, ...node.attrs }))}
    </svg>
  )
}

/** The app's tile, like a project's: its icon on a rounded square. */
export function MiniAppTile({ icon, size = 44 }: { icon: string; size?: number }): JSX.Element {
  return (
    <span className="ma-tile pj-tile" style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }} aria-hidden="true">
      <MiniAppIcon icon={icon} size={Math.round(size * 0.5)} />
    </span>
  )
}
