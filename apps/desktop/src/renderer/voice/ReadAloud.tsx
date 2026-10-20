import { VoiceIcon } from './VoiceIcon'
import { speakText, stopSpeaking, useSpeaker } from './speaker'

/** "Read aloud" under an agent message. A second click stops it. */
export function ReadAloud({ id, text }: { id: string; text: string }): JSX.Element {
  const speaking = useSpeaker((state) => state.speaking === id)
  const loading = useSpeaker((state) => state.loading === id)
  const busy = speaking || loading
  return (
    <button
      type="button"
      className={`read-aloud${busy ? ' on' : ''}`}
      aria-pressed={busy}
      onClick={() => {
        if (busy) stopSpeaking()
        else void speakText(id, text)
      }}
    >
      <VoiceIcon name="speaker" size={16} />
      {loading ? 'Getting ready' : speaking ? 'Stop reading' : 'Read aloud'}
    </button>
  )
}
