import { useEffect, useState } from 'react'

import type { AppInfo } from '@agent/core'

import { agent } from '../bridge'

const PLATFORM_LABEL: Record<AppInfo['platform'], string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
  web: 'the browser preview',
}

export interface AboutDialogProps {
  open: boolean
  onClose: () => void
}

/** Version, licences and the logs folder. Used by Settings once the shell exists. */
export function AboutDialog({ open, onClose }: AboutDialogProps): JSX.Element | null {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    let alive = true
    setError('')
    void agent.app
      .info()
      .then((next) => {
        if (alive) setInfo(next)
      })
      .catch(() => {
        if (alive) setError('Could not read the app details.')
      })
    return () => {
      alive = false
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const title = info?.name ?? 'Agent'
  return (
    <div className="about-backdrop" onMouseDown={onClose}>
      <div
        className="about-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="about-title" className="about-title">
          {title}
        </h2>
        <p className="about-line">Version {info?.version ?? 'unknown'}</p>
        {info ? (
          <p className="about-line">
            Electron {info.electron} on {PLATFORM_LABEL[info.platform]}
          </p>
        ) : null}
        {error ? (
          <p className="about-line" role="alert">
            {error}
          </p>
        ) : null}
        <div className="about-actions">
          <button
            type="button"
            className="about-button"
            onClick={() => void agent.app.openLicences()}
          >
            Licences
          </button>
          <button
            type="button"
            className="about-button"
            onClick={() => void agent.app.openLogsFolder()}
          >
            Open logs folder
          </button>
          <button type="button" className="about-button about-button-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
