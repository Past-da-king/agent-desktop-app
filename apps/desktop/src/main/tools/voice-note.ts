/**
 * `voice_note`: the main agent sends the person a voice note. The note is its own
 * SPOKEN script, written to be heard, never the chat text read out; `style` says how to say it. Only the main
 * agent has it: voice notes are for the person, never for briefing a helper.
 */
import type { Tool } from '@agent/core'

import type { DataStore } from '../runtime/data'

export interface VoiceNoteMaker {
  /** Speaks the script and saves the note. The file name is only meaningful on this computer. */
  note(script: string, style: string): Promise<{ ok: true; file: string; durationMs: number } | { ok: false; error: string }>
}

export const VOICE_NOTE_GUIDE = [
  'VOICE NOTES (voice_note): a voice note is what you would SAY if you rang the user, never your text read aloud. Your chat text stays the short TLDR; the note is its own spoken script with the same facts in a different form.',
  '- Answer first, in one sentence. Then the two or three things that matter, then the ONE thing you need from them, or "nothing needed from you".',
  '- Talk, do not list: no bullets, headings, markdown, tables, code, links or file paths. Say what they are ("the link is in the message").',
  '- Length: a normal answer is under a minute (120 to 150 words). A report or an explanation may run 3 to 4 minutes (350 to 450 words); then structure it out loud ("Three things. First...") and recap the decision at the end.',
  '- Write how people speak: contractions, short sentences. Numbers the way you say them ("about forty percent", "R four hundred").',
  '- Expression, sparingly (one or two per note): <short pause>, <long pause>, <breath>, <laugh>, <chuckle>, <sigh>. They are performed, not read. CAPS on one word gives stress.',
  '- style is how to say it, for the whole note, never inside the script: leave it empty for warm and relaxed, or e.g. "upbeat and pleased, quick", "calm, clear and serious", "South African English accent, relaxed". Keep the same style across a conversation.',
].join('\n')

export function voiceNoteTool(store: DataStore, maker: () => VoiceNoteMaker | null): Tool {
  return {
    spec: {
      name: 'voice_note',
      description:
        'Send the user a voice note: your own spoken script (written for the ear, not your chat text), said in `style`. Send it BEFORE your short text reply. See VOICE NOTES in your instructions for how to write it.',
      schema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'What you say, as you would say it out loud. Under 150 words normally; up to about 450 for a report.' },
          style: { type: 'string', description: 'How to say the whole note, e.g. "upbeat and pleased, quick". Empty for warm and relaxed.' },
        },
        required: ['script'],
      },
    },
    run: async (input) => {
      const script = typeof input['script'] === 'string' ? input['script'].trim() : ''
      const style = typeof input['style'] === 'string' ? input['style'].trim() : ''
      if (script === '') return 'Write the script first: what you would say out loud.'
      const voice = maker()
      if (voice === null) return 'Voice notes need a Gemini key (Settings, Voice). Reply in text instead.'
      const made = await voice.note(script, style)
      if (!made.ok) return `The voice note could not be made: ${made.error} Reply in text instead.`
      await store.upsert('chat_item', {
        kind: 'voice_note',
        text: script,
        meta: JSON.stringify({ file: made.file, durationMs: made.durationMs, style }),
      })
      return 'The voice note is in the chat. Now write only your short text reply; do not repeat the note.'
    },
  }
}
