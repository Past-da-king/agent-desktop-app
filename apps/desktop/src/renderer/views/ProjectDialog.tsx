import { PROFILE_COLORS, type AiPicks, type ProfileColor, type ProjectRow } from '@agent/core'
import { useRef, useState, type CSSProperties } from 'react'

import { agent } from '../bridge'
import { hasAccounts } from '../lib/ai'
import { iconFromFile } from '../lib/icon-image'
import { toneStyle } from '../lib/profiles'
import { PROJECT_GLYPHS, singleEmoji } from '../lib/projects'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { ProjectTile } from '../ui/ProjectTile'
import { Switch } from '../ui/Switch'
import { useSettings } from '../state/useSettings'
import { AiPickRows } from '../ui/AiPickRows'
import { useProfiles } from './Profiles'

/**
 * Make or change a project: its name, an icon like an app icon (a glyph or an emoji on a coloured tile), the folder
 * its agents work in, the profile whose accounts and logins its helpers use, and a line on what it is for.
 * `onClose` gets the project's id when one was made or saved.
 */
export function ProjectDialog({ project, onClose }: { project?: ProjectRow; onClose: (id: string | null) => void }): JSX.Element {
  const profiles = useProfiles() ?? []
  const [name, setName] = useState(project?.name ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [glyph, setGlyph] = useState(project?.icon.glyph ?? 'folder')
  const [color, setColor] = useState<ProfileColor>(project?.icon.color ?? 'iris')
  const [emoji, setEmoji] = useState(project !== undefined && singleEmoji(project.icon.glyph) !== '' ? project.icon.glyph : '')
  const [image, setImage] = useState(project?.icon.image ?? '')
  const [pictureError, setPictureError] = useState('')
  const pictureInput = useRef<HTMLInputElement>(null)
  const [path, setPath] = useState(project?.path ?? '')
  const [profile, setProfile] = useState(project?.profile ?? '')
  const [ai, setAi] = useState<AiPicks>(project?.ai ?? { main: { account: '', model: '' }, helpers: { account: '', model: '' } })
  const settings = useSettings((state) => state.settings)
  const [hidden, setHidden] = useState(project?.hidden ?? false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const picked = singleEmoji(emoji)
  const icon = { glyph: picked !== '' ? picked : glyph, color, ...(image === '' ? {} : { image }) }

  const save = async (): Promise<void> => {
    const clean = name.trim().replace(/\s+/g, ' ').slice(0, 60)
    if (clean === '') {
      setError('Give the project a name.')
      return
    }
    setBusy(true)
    try {
      const row = await agent.data.upsert('project', {
        ...(project === undefined ? { chats: [] } : { id: project.id }),
        name: clean,
        description: description.trim().slice(0, 600),
        icon,
        path,
        profile,
        hidden,
        ai,
      })
      onClose(row.id)
    } catch (cause) {
      setError(cause instanceof Error && cause.message !== '' ? cause.message : 'Could not save the project.')
      setBusy(false)
    }
  }

  return (
    <Dialog label={project === undefined ? 'New project' : 'Edit project'} onClose={() => onClose(null)} labelledBy="project-dialog-title" className="pj-dialog">
      <div className="pj-dlg-head">
        <ProjectTile icon={icon} size={56} />
        <div>
          <span className="eyebrow">{project === undefined ? 'NEW PROJECT' : 'EDIT PROJECT'}</span>
          <h2 className="h2" id="project-dialog-title" style={{ marginTop: 6 }}>
            {name.trim() === '' ? 'A place for one piece of work' : name.trim()}
          </h2>
        </div>
      </div>

      <Field
        label="Name"
        value={name}
        onChange={(value) => {
          setName(value)
          setError('')
        }}
        placeholder="Guavas website"
        error={error === '' ? undefined : error}
      />

      <div className="field">
        <label>Icon</label>
        <div className="pj-glyphs" role="radiogroup" aria-label="Icon">
          {PROJECT_GLYPHS.map((each) => (
            <button
              key={each}
              type="button"
              role="radio"
              aria-checked={image === '' && picked === '' && glyph === each}
              aria-label={each}
              className={`pj-glyph${image === '' && picked === '' && glyph === each ? ' on' : ''}`}
              onClick={() => {
                setGlyph(each)
                setEmoji('')
                setImage('')
              }}
            >
              <Icon name={each} size={20} />
            </button>
          ))}
          <input
            className="input pj-emoji-in"
            aria-label="Or an emoji"
            placeholder="Emoji"
            value={emoji}
            maxLength={8}
            onChange={(event) => {
              setEmoji(event.target.value)
              if (event.target.value.trim() !== '') setImage('')
            }}
          />
        </div>
        <div className="pj-pic">
          <input
            ref={pictureInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/x-icon,image/svg+xml"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file === undefined) return
              setPictureError('')
              void iconFromFile(file)
                .then(setImage)
                .catch((cause: unknown) => setPictureError(cause instanceof Error ? cause.message : 'That picture could not be used.'))
            }}
          />
          <Button variant="tonal" size="sm" onClick={() => pictureInput.current?.click()}>
            <Icon name="shot" size={16} />
            {image === '' ? 'Use my own picture' : 'Choose another picture'}
          </Button>
          {image !== '' ? (
            <Button variant="text" size="sm" onClick={() => setImage('')}>
              Use the icon instead
            </Button>
          ) : null}
          <span className="pj-pic-note">{pictureError !== '' ? pictureError : 'A logo or any picture; it is cut square.'}</span>
        </div>
        <div className="pj-colors" role="radiogroup" aria-label="Colour">
          {PROFILE_COLORS.map((each) => (
            <button
              key={each}
              type="button"
              role="radio"
              aria-checked={color === each}
              aria-label={each}
              className={`pf pj-color${color === each ? ' on' : ''}`}
              style={toneStyle(each) as CSSProperties}
              onClick={() => setColor(each)}
            >
              {color === each ? <Icon name="check" size={14} /> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label>Folder</label>
        <div className="pj-folder">
          <span className={`pj-folder-path${path === '' ? ' none' : ''}`} title={path}>
            <Icon name="folder" size={16} />
            {path === '' ? 'No folder yet' : path}
          </span>
          <Button
            variant="tonal"
            size="sm"
            onClick={() => {
              void agent.files.pickFolder().then((picked) => {
                if (picked !== null) setPath(picked)
              })
            }}
          >
            {path === '' ? 'Choose folder' : 'Change'}
          </Button>
          {path === '' ? null : (
            <Button variant="text" size="sm" onClick={() => setPath('')}>
              Clear
            </Button>
          )}
        </div>
        <span className="small muted pj-hint">Its agents work in this folder by default.</span>
      </div>

      <div className="field">
        <label htmlFor="project-profile">Profile</label>
        <select id="project-profile" className="input" value={profile} onChange={(event) => setProfile(event.target.value)}>
          <option value="">General (no accounts)</option>
          {profiles.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name}
            </option>
          ))}
        </select>
        <span className="small muted pj-hint">Its helpers use this profile's accounts and logins.</span>
      </div>

      {settings !== null && hasAccounts(settings) ? (
        <div className="field">
          <label>AI</label>
          <AiPickRows settings={settings} picks={ai} inherit={settings.ai} onChange={setAi} />
          <span className="small muted pj-hint">What the agent in its chats thinks with, and what its helpers think with.</span>
        </div>
      ) : null}

      <div className="field">
        <label htmlFor="project-description">What it is for</label>
        <textarea
          id="project-description"
          className="textarea"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="One or two lines: the goal, who it is for, anything its agents should always know."
        />
      </div>

      {project === undefined ? null : (
        <div className="pj-hide">
          <span>Hide it from the rail. It stays in search and under Hidden.</span>
          <Switch on={hidden} onToggle={setHidden} label="Hide this project from the rail" />
        </div>
      )}

      <div className="dialog-actions">
        <Button variant="text" onClick={() => onClose(null)}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            void save()
          }}
          disabled={busy}
        >
          {busy ? 'Saving...' : project === undefined ? 'Create project' : 'Save changes'}
        </Button>
      </div>
    </Dialog>
  )
}
