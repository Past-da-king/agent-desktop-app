import type { MentionProject } from '../../shared/mentions'
import { ProjectTile } from '../ui/ProjectTile'

/**
 * The list '@' opens above the message box: his projects that fit what he typed, each with its icon and colour.
 * Picking one writes its name in; the message then goes to that project's chat (main/runtime/mentions.ts).
 */
export function MentionPicker({ items, active, onPick, onHover }: { items: MentionProject[]; active: number; onPick: (project: MentionProject) => void; onHover: (index: number) => void }): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className="mention-pick" role="listbox" aria-label="Send to a project">
      <div className="mention-head">Send to a project</div>
      {items.map((project, index) => (
        <button
          key={project.id}
          type="button"
          role="option"
          aria-selected={index === active}
          className={index === active ? 'mention-row on' : 'mention-row'}
          // Keeps the caret in the message box: the pick happens on mouse down, before the box loses focus.
          onMouseDown={(event) => {
            event.preventDefault()
            onPick(project)
          }}
          onMouseEnter={() => onHover(index)}
        >
          <ProjectTile icon={{ glyph: project.glyph, color: project.color as never, ...(project.image === '' ? {} : { image: project.image }) }} size={28} />
          <span className="mention-name">{project.name}</span>
          {project.aliases.length > 0 ? <span className="mention-also">{project.aliases.join(', ')}</span> : null}
        </button>
      ))}
    </div>
  )
}
