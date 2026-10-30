import { MAIN_CHAT, attachmentProblem, type Attachment } from '@agent/core'
import { memo, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, forwardRef, type CSSProperties, type ClipboardEvent } from 'react'

import { agent, chat } from '../bridge'
import { draftFromBox, joinDraft } from '../../shared/box-draft'
import { chipFromPick, chipFromTyping, chipOf, mentionAtCaret, mentionDone, mentionProjects, rankMentions, withChip, type MentionProject } from '../../shared/mentions'
import { toneStyle } from '../lib/profiles'
import { ProjectTile } from '../ui/ProjectTile'
import { useEntity } from '../state/useData'
import { useChatRunning } from '../state/useChats'
import { useDrafts } from '../state/useDrafts'
import { useSettings } from '../state/useSettings'
import { toast } from '../state/useToast'
import { useUi } from '../state/useUi'
import { IconButton, Kbd } from '../ui/bits'
import { Icon } from '../ui/Icon'
import { DictateButton } from '../voice/DictateButton'
import { DictationDraft } from '../voice/DictationDraft'
import { isEditable, useDictationDraft } from '../voice/dictationBox'
import { RecoverChips } from '../voice/RecoverChips'
import { AttachmentChip } from './AttachmentChip'
import { MentionPicker } from './MentionPicker'

const NO_FILES: Attachment[] = []

/** Pasted text longer than this goes along as a text file instead of filling the composer (and the message limit). */
const LONG_PASTE_CHARS = 12_000

/** Where a pasted or dropped File object without a path on disk ends up: saved by the main process first. */
async function saveFileObject(file: File): Promise<Attachment> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const type = file.type === '' ? 'application/octet-stream' : file.type
  const name = file.name !== '' && file.name !== 'image.png' ? file.name : `Pasted ${type.startsWith('image/') ? 'image' : 'file'} ${new Date().toTimeString().slice(0, 8).replace(/:/g, '.')}${type === 'image/png' ? '.png' : ''}`
  return agent.files.savePasted(name, type, bytes)
}

/**
 * Turn File objects (from a paste or a drop) into attachments: a file with a real path attaches by path, one
 * without (a screenshot, an image copied from a page) is saved first. Too-big files are named in `problems`.
 */
export async function filesToAttachments(files: File[]): Promise<{ allowed: Attachment[]; problems: string[] }> {
  const allowed: Attachment[] = []
  const problems: string[] = []
  for (const file of files) {
    const problem = attachmentProblem(file.name || 'That file', file.size)
    if (problem !== null) {
      problems.push(problem)
      continue
    }
    const path = agent.files.pathsFor([file])[0] ?? ''
    if (path !== '') {
      allowed.push({ path, name: file.name, mime: file.type === '' ? 'application/octet-stream' : file.type, size: file.size })
      continue
    }
    try {
      allowed.push(await saveFileObject(file))
    } catch (error) {
      problems.push(error instanceof Error && error.message !== '' ? error.message : `${file.name || 'That file'} could not be attached.`)
    }
  }
  return { allowed, problems }
}

/** What the chat around the composer may ask of it: files dropped anywhere on the chat land here. */
export interface ComposerHandle {
  takeFiles(files: File[]): void
  focus(): void
}

/**
 * The message box: its text, files, paste and dictation. It keeps all of that state to itself, so a keystroke
 * never re-renders the thread above it. `onSend` runs just before a message goes, for the thread to stick to the
 * bottom.
 */
export const Composer = memo(
  forwardRef<ComposerHandle, { chatId: string; onSend: () => void }>(function Composer({ chatId, onSend }, ref) {
    const hasVoiceKey = useSettings((state) => state.settings?.hasVoiceKey === true)
    const focusToken = useUi((state) => state.composerFocus)
    const running = useChatRunning(chatId)
    // The draft lives per chat outside this box, on disk at every change: a dictation can reach it from anywhere.
    const text = useDrafts((state) => state.texts[chatId] ?? '')
    const attachments = useDrafts((state) => state.files[chatId] ?? NO_FILES)
    const addedToDraft = useDrafts((state) => state.added[chatId] ?? 0)
    const setText = (next: string): void => useDrafts.getState().setText(chatId, next)
    const setAttachments = (next: Attachment[] | ((current: Attachment[]) => Attachment[])): void => {
      const store = useDrafts.getState()
      store.setFiles(chatId, typeof next === 'function' ? next(store.files[chatId] ?? NO_FILES) : next)
    }
    const dictation = useDictationDraft()
    const dictatingHere = dictation !== null && dictation.chat === chatId && ['starting', 'listening', 'finishing', 'cleaning'].includes(dictation.phase)
    const live = dictatingHere ? [dictation.text.trim(), dictation.interim.trim()].filter((part) => part !== '').join(' ') : ''
    const [attachProblem, setAttachProblem] = useState('')
    const [reading, setReading] = useState(false)
    const composer = useRef<HTMLTextAreaElement>(null)
    // '@' offers his projects (shared/mentions.ts); the main process sends a message that names one to its chat.
    const projectRows = useEntity('project')
    const projects = useMemo(() => mentionProjects(projectRows), [projectRows])
    const [caret, setCaret] = useState(0)
    const [pickIndex, setPickIndex] = useState(0)
    const [dismissedAt, setDismissedAt] = useState(-1)
    // The message stays '@Name words' (what the computer routes); the box shows the project as a chip in front.
    const chip = chipOf(text, projects)
    const words = chip === null ? text : chip.rest
    // The words still being heard show in the box after his text; they join the draft when they are final.
    const shown = joinDraft(words, live)
    const typing = live === '' ? mentionAtCaret(words, caret) : null
    const picks: MentionProject[] = typing === null || typing.start === dismissedAt || mentionDone(typing.query, projects) ? [] : rankMentions(typing.query, projects, 6)
    const picking = picks.length > 0
    const active = Math.min(pickIndex, Math.max(0, picks.length - 1))
    const placeCaret = (at: number): void => {
      setCaret(at)
      requestAnimationFrame(() => {
        const area = composer.current
        if (area === null) return
        area.focus()
        area.setSelectionRange(at, at)
      })
    }
    const pick = (project: MentionProject): void => {
      const next = chipFromPick(words, caret, project)
      setText(withChip(project, next.rest))
      setPickIndex(0)
      placeCaret(next.caret)
    }
    const dropChip = (): void => {
      setText(words)
      placeCaret(0)
    }

    useEffect(() => {
      if (focusToken === 0) return
      const draft = useUi.getState().composerDraft
      if (draft !== '') {
        setText(draft)
        useUi.setState({ composerDraft: '' })
      }
      composer.current?.focus()
    }, [focusToken])

    useEffect(() => {
      const area = composer.current
      if (!area) return
      area.style.height = '48px'
      area.style.height = `${Math.min(area.scrollHeight, 140)}px`
    }, [shown])

    // Another chat's box: the cursor at the end of its own draft, nothing of the last chat's '@' list.
    useEffect(() => {
      const end = useDrafts.getState().texts[chatId]?.length ?? 0
      setCaret(end)
      setDismissedAt(-1)
      composer.current?.setSelectionRange(end, end)
    }, [chatId])

    /** The cursor into the box, unless he is typing in another field or selecting text to copy. */
    const takeCursor = (): void => {
      const area = composer.current
      if (area === null || document.activeElement === area) return
      if (isEditable(document.activeElement)) return
      const selection = window.getSelection()
      if (selection !== null && !selection.isCollapsed) return
      area.focus()
      area.setSelectionRange(area.value.length, area.value.length)
    }

    // While a dictation for this box runs the cursor stays in it, and comes back when it ends or the words land.
    const dictatingNow = useRef(dictatingHere)
    dictatingNow.current = dictatingHere
    useEffect(() => {
      if (!dictatingHere) return
      takeCursor()
      const onWindowFocus = (): void => takeCursor()
      window.addEventListener('focus', onWindowFocus)
      return () => {
        window.removeEventListener('focus', onWindowFocus)
        takeCursor()
      }
    }, [dictatingHere, chatId])
    const seenAdded = useRef(addedToDraft)
    useEffect(() => {
      if (seenAdded.current === addedToDraft) return
      seenAdded.current = addedToDraft
      takeCursor()
    }, [addedToDraft])

    // Each new live word is drawn by replacing the box's text: the cursor stays where he has it, or at the end.
    const beforeLive = useRef({ shown, start: shown.length, end: shown.length })
    useLayoutEffect(() => {
      const area = composer.current
      const was = beforeLive.current
      if (area !== null && was.shown !== shown && live !== '') {
        const atEnd = was.end >= was.shown.length
        if (atEnd) {
          area.setSelectionRange(shown.length, shown.length)
          area.scrollTop = area.scrollHeight
        } else {
          area.setSelectionRange(was.start, was.end)
        }
      }
      beforeLive.current = { shown, start: area?.selectionStart ?? shown.length, end: area?.selectionEnd ?? shown.length }
    }, [shown, live])
    const noteCursor = (area: HTMLTextAreaElement): void => {
      beforeLive.current = { shown: area.value, start: area.selectionStart, end: area.selectionEnd }
    }

    const send = (): void => {
      const value = text.trim()
      if (value === '' && attachments.length === 0) return
      const sentFrom = chatId
      const sent = attachments
      onSend()
      // The box empties at once; the words stay on disk until the message was accepted.
      useDrafts.getState().sending(sentFrom)
      setCaret(0)
      setDismissedAt(-1)
      setAttachProblem('')
      // chat.send only settles when the whole turn ends, so the first sign the chat has it counts as accepted.
      let settled = false
      const off = chat.onEvent((event) => {
        if (settled || (event.chat ?? MAIN_CHAT) !== sentFrom) return
        if (event.type === 'run_started' || event.type === 'chat_changed') accepted()
      })
      const accepted = (): void => {
        if (settled) return
        settled = true
        off()
        useDrafts.getState().accepted(sentFrom)
      }
      chat.send(value, sent, sentFrom).then(accepted, () => {
        if (settled) return
        settled = true
        off()
        useDrafts.getState().refused(sentFrom)
        toast('That message did not go. It is back in the box.')
      })
    }

    const accept = (incoming: Attachment[]): void => {
      if (incoming.length === 0) return
      setAttachments((current) => {
        const known = new Set(current.map((item) => item.path))
        return [...current, ...incoming.filter((item) => !known.has(item.path))]
      })
    }

    const pickFiles = async (): Promise<void> => {
      try {
        const picked = await agent.files.pick()
        const problems: string[] = []
        const allowed: Attachment[] = []
        for (const file of picked) {
          const problem = file.size === undefined ? null : attachmentProblem(file.name, file.size)
          if (problem !== null) problems.push(problem)
          else allowed.push(file)
        }
        accept(allowed)
        setAttachProblem(problems[0] ?? '')
      } catch (error) {
        setAttachProblem(error instanceof Error ? error.message : 'Could not open the file picker.')
      }
    }

    /** Files from a paste or a drop: attach them, and say plainly if one could not be. */
    const takeFiles = async (files: File[]): Promise<void> => {
      setReading(true)
      try {
        const { allowed, problems } = await filesToAttachments(files)
        accept(allowed)
        setAttachProblem(problems[0] ?? '')
      } finally {
        setReading(false)
      }
    }

    useImperativeHandle(ref, () => ({ takeFiles: (files) => void takeFiles(files), focus: () => composer.current?.focus() }), [])

    /**
     * Ctrl+V. Files (copied in Explorer, or a screenshot) become chips; plain text pastes as text, unless it is
     * very long, then it goes along as a text file. When the paste brings neither (some Explorer copies reach
     * the window with no File objects), the main process reads the files off the system clipboard.
     */
    const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
      const data = event.clipboardData
      const files = Array.from(data.files)
      const plain = data.getData('text/plain')
      const html = data.getData('text/html')
      const onlyPictures = files.length > 0 && files.every((file) => file.type.startsWith('image/'))
      // A copied spreadsheet range or web text also carries a picture of itself: the words are what was meant.
      if (plain.trim() !== '' && (files.length === 0 || onlyPictures)) {
        if (plain.length <= LONG_PASTE_CHARS) return
        event.preventDefault()
        const bytes = new TextEncoder().encode(plain)
        setReading(true)
        void agent.files
          .savePasted('Pasted text.txt', 'text/plain', bytes)
          .then((saved) => {
            accept([saved])
            setAttachProblem('')
          })
          .catch(() => setAttachProblem('That text is too long to paste. Save it as a file and attach it.'))
          .finally(() => setReading(false))
        return
      }
      if (files.length > 0) {
        event.preventDefault()
        void takeFiles(files)
        return
      }
      if (plain.trim() === '' && html.trim() === '') {
        event.preventDefault()
        setReading(true)
        void agent.files
          .clipboardFiles()
          .then((found) => {
            const allowed = found.filter((file) => file.size === undefined || attachmentProblem(file.name, file.size) === null)
            const tooBig = found.find((file) => file.size !== undefined && attachmentProblem(file.name, file.size) !== null)
            accept(allowed)
            setAttachProblem(tooBig !== undefined && tooBig.size !== undefined ? (attachmentProblem(tooBig.name, tooBig.size) ?? '') : '')
          })
          .catch(() => setAttachProblem('Nothing on the clipboard could be attached.'))
          .finally(() => setReading(false))
      }
    }

    return (
      <>
        {attachProblem !== '' ? (
          <div className="banner warn attach-warn" role="alert">
            {attachProblem}
          </div>
        ) : null}
        {attachments.length > 0 || reading ? (
          <div className="attach-row" aria-label="Files to send">
            {attachments.map((file) => (
              <AttachmentChip
                key={file.path}
                file={file}
                onRemove={() => {
                  setAttachments((current) => current.filter((item) => item.path !== file.path))
                }}
              />
            ))}
            {reading ? (
              <div className="att-chip reading" role="status">
                <span className="att-icon" aria-hidden="true">
                  <Icon name="clip" size={20} />
                </span>
                <span className="att-text">
                  <span className="att-name">Adding files</span>
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
        <RecoverChips chat={chatId} />
        <DictationDraft chat={chatId} />
        {picking ? <MentionPicker items={picks} active={active} onPick={pick} onHover={setPickIndex} /> : null}
        <div className="compose-in">
          <IconButton
            icon="clip"
            label="Attach a file"
            onClick={() => {
              void pickFiles()
            }}
          />
          <IconButton icon="shot" label="Grab a screenshot" comingSoon className="hide-m" />
          {chip !== null ? (
            <span className="pf mention-chip" style={toneStyle(chip.project.color) as CSSProperties} title={`Goes to ${chip.project.name}`}>
              <ProjectTile icon={{ glyph: chip.project.glyph, color: chip.project.color as never, ...(chip.project.image === '' ? {} : { image: chip.project.image }) }} size={18} />
              <span className="mention-chip-name">{chip.project.name}</span>
              <button type="button" className="mention-chip-x" aria-label={`Do not send to ${chip.project.name}`} onClick={dropChip}>
                <Icon name="x" size={12} />
              </button>
            </span>
          ) : null}
          <textarea
            ref={composer}
            rows={1}
            placeholder={running ? 'Add to this, or ask for something else' : 'Ask anything, or @ a project'}
            aria-label="Message"
            data-composer={chatId}
            value={shown}
            onBlur={() => {
              // A click on nothing in particular while it records does not take the cursor out of the box.
              if (dictatingNow.current) setTimeout(() => dictatingNow.current && takeCursor(), 0)
            }}
            onChange={(event) => {
              noteCursor(event.target)
              const typed = draftFromBox(event.target.value, words, live)
              const at = Math.min(event.target.selectionStart, typed.length)
              // A whole '@name' and a space becomes the chip at once ("@acme " -> [Acme]).
              const made = chipFromTyping(typed, at, projects)
              if (made !== null) {
                setText(withChip(made.project, made.rest))
                setPickIndex(0)
                placeCaret(made.caret)
                return
              }
              setText(chip === null ? typed : withChip(chip.project, typed))
              setCaret(at)
              setPickIndex(0)
              // Escape closes the list for that one '@' word; once it is gone, the next '@' opens it again.
              if (dismissedAt >= 0 && mentionAtCaret(typed, at)?.start !== dismissedAt) setDismissedAt(-1)
            }}
            onSelect={(event) => {
              noteCursor(event.currentTarget)
              setCaret(event.currentTarget.selectionStart)
            }}
            onPaste={onPaste}
            aria-autocomplete="list"
            aria-expanded={picking}
            onKeyDown={(event) => {
              // Backspace right after the chip takes the whole chip away in one press.
              if (chip !== null && event.key === 'Backspace' && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0) {
                event.preventDefault()
                dropChip()
                return
              }
              if (picking && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault()
                setPickIndex((active + (event.key === 'ArrowDown' ? 1 : picks.length - 1)) % picks.length)
                return
              }
              if (picking && (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
                event.preventDefault()
                const chosen = picks[active]
                if (chosen !== undefined) pick(chosen)
                return
              }
              if (picking && event.key === 'Escape') {
                event.preventDefault()
                setDismissedAt(typing?.start ?? -1)
                return
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send()
              }
            }}
          />
          <DictateButton
            hasKey={hasVoiceKey}
            chat={chatId}
            focusBox={() => composer.current?.focus()}
            onText={(heard) => {
              useDrafts.getState().addWords(chatId, heard)
              composer.current?.focus()
            }}
            onProblem={(message, action) => {
              if (action === undefined) setAttachProblem(message)
              else toast(message, { actionLabel: action.label, onAction: action.run })
            }}
          />
          {running && text.trim() === '' && attachments.length === 0 ? (
            <button
              type="button"
              className="send"
              aria-label="Stop"
              title="Stop this chat's work"
              onClick={() => {
                void chat.stop(chatId)
              }}
            >
              <Icon name="stop" size={22} />
            </button>
          ) : (
            <button
              type="button"
              className="send"
              onClick={send}
              aria-label={running ? 'Send while it works' : 'Send'}
              title={running ? 'Send. About this job, it joins in; something else, it runs alongside.' : 'Send'}
              disabled={text.trim() === '' && attachments.length === 0}
            >
              <Icon name="arrow" size={22} />
            </button>
          )}
        </div>
        <div className="cfoot">
          <span>
            <Kbd>Enter</Kbd> send
          </span>
          <span>
            <Kbd>Shift</Kbd> <Kbd>Enter</Kbd> new line
          </span>
          <span>
            <Kbd>Ctrl</Kbd> <Kbd>V</Kbd> paste files or pictures
          </span>
        </div>
      </>
    )
  }),
)
