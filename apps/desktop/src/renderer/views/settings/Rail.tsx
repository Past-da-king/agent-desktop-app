/**
 * The section rail of Settings (4 Nov 2026): the ten sections in order with how many settings each holds. It scrolls
 * the page to a section and marks the one on screen. Git and developer and Advanced are listed only while Developer
 * settings is on, and say they are hidden when they are found by a search instead.
 */
import { Icon } from '../../ui/Icon'
import type { RailSection, SectionId } from './registry'

/** The section the page opens on. */
export const DEFAULT_SECTION: SectionId = 'account'

export function SettingsRail({
  sections,
  current,
  onPick,
}: {
  sections: RailSection[]
  current: SectionId
  onPick: (id: SectionId) => void
}): JSX.Element {
  return (
    <nav className="snav" aria-label="Settings sections">
      {sections.map(({ section, count }) => {
        const on = section.id === current
        return (
          <button
            key={section.id}
            type="button"
            className={on ? 'on' : ''}
            aria-current={on ? true : undefined}
            onClick={() => onPick(section.id)}
          >
            <Icon name={section.icon} size={16} />
            <span className="lbl">{section.name}</span>
            {count > 0 ? <span className="n">{count}</span> : null}
          </button>
        )
      })}
      <div className="foot">
        Everything saves as you change it. Git and developer and Advanced appear while <b>Developer settings</b> is on,
        at the bottom of Privacy and data.
      </div>
    </nav>
  )
}
