import { attachmentKind, fileSizeLabel, type Attachment } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent } from '../bridge'
import { isImageFile } from '../lib/files'
import { handedPageTitle, isHandedPage } from '../../shared/hand-over'
import { Icon } from '../ui/Icon'

export function useThumbnail(file: Attachment): string | null {
  const [src, setSrc] = useState<string | null>(null)
  const image = isImageFile(file)

  useEffect(() => {
    if (!image) {
      setSrc(null)
      return
    }
    let live = true
    agent.files
      .thumbnail(file.path)
      .then((url) => {
        if (live) setSrc(url)
      })
      .catch(() => {
        // A thumbnail is a nicety: a file that cannot be read still attaches by path.
      })
    return () => {
      live = false
    }
  }, [file.path, image])

  return src
}

/** What kind of file a chip shows, in a word. */
function kindWord(file: Attachment): string {
  const kind = attachmentKind(file.name, file.mime)
  if (file.mime === 'inode/directory') return 'Folder'
  if (kind === 'image') return 'Picture'
  if (kind === 'text') return 'Text'
  if (kind === 'document') return (file.name.split('.').pop() ?? 'Document').toUpperCase()
  const ext = file.name.includes('.') ? (file.name.split('.').pop() ?? '') : ''
  return ext === '' ? 'File' : ext.toUpperCase()
}

/** A file waiting to be sent: picture or file icon, name, size and kind, and a button that takes it off. */
export function AttachmentChip({ file, onRemove }: { file: Attachment; onRemove: () => void }): JSX.Element {
  const src = useThumbnail(file)
  const size = file.size === undefined ? '' : fileSizeLabel(file.size)
  // A page handed over from the browser: shown as the page it is, not as a text file.
  if (isHandedPage(file.name)) {
    const title = handedPageTitle(file.name)
    return (
      <div className="att-chip att-page" title={`${title}: the page you handed over, with its address, tab and selected text`}>
        <span className="att-icon" aria-hidden="true">
          <Icon name="globe" size={20} />
        </span>
        <span className="att-text">
          <span className="att-name">{title}</span>
          <span className="att-meta">Page from the browser</span>
        </span>
        <button type="button" className="att-x" onClick={onRemove} aria-label={`Remove the page ${title}`} title="Remove">
          <Icon name="x" size={16} />
        </button>
      </div>
    )
  }
  return (
    <div className="att-chip" title={file.path}>
      {src !== null ? (
        <img className="att-thumb" src={src} alt="" />
      ) : (
        <span className="att-icon" aria-hidden="true">
          <Icon name={file.mime === 'inode/directory' ? 'folder' : 'file'} size={20} />
        </span>
      )}
      <span className="att-text">
        <span className="att-name">{file.name}</span>
        <span className="att-meta">{[kindWord(file), size].filter((part) => part !== '').join(', ')}</span>
      </span>
      <button type="button" className="att-x" onClick={onRemove} aria-label={`Remove ${file.name}`} title="Remove">
        <Icon name="x" size={16} />
      </button>
    </div>
  )
}

