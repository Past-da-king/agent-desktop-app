/**
 * Dictation never types a name he did not say (29 Oct 2026: "Cosmiprint", "Network architecture.", "Ayanda's
 * birthday.", "Zernio for Cosmiprint" appeared in his dictations). The recogniser was biased with memory page titles;
 * it said them into quiet stretches. Names-only stretches are dropped on every path, titles are no longer sent, and
 * clean-up or alias fixing can only respell a word that was said.
 */
import { afterEach, describe, expect, it } from 'vitest'

import type { MemoryRow, ProjectRow } from '@agent/core'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { addedNames, onlyNames, nameWords, stretches, stripInjectedNames } from '../src/main/dictation/injected'
import { respellNames, soundsLike } from '../src/main/dictation/respell'
import { LiveTranscriber, replayRecording } from '../src/main/dictation/transcriber'
import { applyAliases, dictationWordsFromProjects, nameTerm, vocabularyFrom } from '../src/main/memory/vocabulary'
import type { SocketLike } from '../src/main/voice/live'
import { startFakeLive, type FakeLive } from './fake-live'

let live: FakeLive | null = null
afterEach(async () => {
  await live?.close()
  live = null
})

const nodeSocket = (url: string): SocketLike => new (globalThis as unknown as { WebSocket: new (url: string) => SocketLike }).WebSocket(url)

const NAMES = ['Ayanda', 'Cosmiprint', 'Initech', 'Northwind', 'Strat Edge', 'Impetix', 'GrowFactory']

function page(title: string, kind: string, aliases = ''): MemoryRow {
  return { id: title, title, body: '', kind, topics: '', pinned: false, source: 'agent', createdAt: 1, updatedAt: 1, aliases } as MemoryRow
}

describe('only names go to the recogniser', () => {
  it('keeps names and drops titles that are descriptions', () => {
    for (const name of ['Cosmiprint', 'Initech', 'Northwind TVET College', 'Strat Edge', 'Bank of Africa', 'GrowOS']) expect(nameTerm(name)).toBe(name)
    expect(nameTerm('StudyCanvas (StudyCVNS)')).toBe('StudyCanvas')
    for (const title of [
      "Ayanda's birthday",
      'Network architecture',
      'Zernio for Cosmiprint (sign-in)',
      "Ayanda's wake-up day",
      'How Ayanda wants his agent to work',
      'Cosmiprint: the agents run it as their own business',
      'Decision: a run’s browser tabs close when it ends',
      'Acme Lender Selector tool',
      'lender select',
    ]) expect(nameTerm(title)).toBeNull()
  })

  it('vocabulary from memory carries no page title that is not a name, and alias targets are names', () => {
    const vocabulary = vocabularyFrom([
      page("Ayanda's birthday", 'event', 'birthday'),
      page('Network architecture', 'project'),
      page('Zernio for Cosmiprint (sign-in)', 'how-to', 'Zeno, Xeno'),
      page('Cosmiprint', 'project'),
      page('Initech', 'fact', 'Initeck'),
      page('How Ayanda wants his agent to work', 'preference', 'wall of text rule'),
    ])
    expect(vocabulary.names).toEqual(['Cosmiprint', 'Initech'])
    expect(vocabulary.aliases).toEqual([{ heard: 'Initeck', name: 'Initech' }])
    const projects = dictationWordsFromProjects([
      { id: 'p1', createdAt: 1, name: 'Cosmiprint', aliases: ['star signs website', 'Cosmi'] } as ProjectRow,
    ])
    expect(projects).toEqual(['Cosmiprint', 'Cosmi'])
  })

  it('an alias only respells what was said: it never adds a word', () => {
    const vocabulary = { names: ['Panache Services', 'Initech'], aliases: [{ heard: 'Panache', name: 'Panache Services' }, { heard: 'Initech Corp', name: 'Initech' }] }
    expect(applyAliases('Ask Panache about Initech Corp.', vocabulary)).toBe('Ask Panache about Initech.')
  })
})

describe('a stretch of only names is left out', () => {
  it('cuts text into stretches at sentence ends and glued joins, not inside web addresses', () => {
    expect(stretches('What update was this for?Cosmiprint. Someone added it.')).toEqual(['What update was this for?', 'Cosmiprint.', ' Someone added it.'])
    expect(stretches('Go to platform.growos.ai now.')).toEqual(['Go to platform.growos.ai now.'])
  })

  it('knows a names-only stretch from speech that has a name in it', () => {
    const words = nameWords(NAMES)
    expect(onlyNames('Cosmiprint.', words)).toBe(true)
    expect(onlyNames(' Strat Edge and Impetix.', words)).toBe(true)
    expect(onlyNames('Send it to Initech.', words)).toBe(false)
    expect(onlyNames('Yeah, yeah, yeah.', words)).toBe(false)
    expect(onlyNames('', words)).toBe(false)
  })

  it('takes the injected names out of his real dictations of 29 Oct and keeps the rest word for word', () => {
    // 20261029-172828-59bf
    expect(stripInjectedNames("I'm really wondering now. What update was this for?Cosmiprint. Someone just added an update.", NAMES).text).toBe(
      "I'm really wondering now. What update was this for? Someone just added an update.",
    )
    // 20261029-114708-7f93, live words, with the titles that were in the list that day
    const titles = [...NAMES, 'Network architecture', "Ayanda's birthday"]
    expect(stripInjectedNames('You know the URL, why am I telling you the URL? Network architecture. Ayanda\'s birthday. I just have to send you the sign up.', titles).text).toBe(
      'You know the URL, why am I telling you the URL? I just have to send you the sign up.',
    )
    // A name he says inside a sentence stays.
    const said = 'Before I mentioned Cosmiprint, that was not me.'
    expect(stripInjectedNames(said, NAMES)).toEqual({ text: said, dropped: [] })
  })

  it('clean-up may not bring in a name the transcript did not have', () => {
    expect(addedNames('send it to initech today', 'Send it to Initech today.', NAMES)).toEqual([])
    expect(addedNames('we are wasting real estate', 'Cosmiprint: we are wasting real estate.', NAMES)).toEqual(['cosmiprint'])
  })
})

describe('silence and unrelated speech never type a project name', () => {
  const session = (url: string, injected: string[]): LiveTranscriber =>
    new LiveTranscriber({ url, key: 'k', model: 'gemini-3.5-transcribe-live', socket: nodeSocket, vocabulary: NAMES, onUpdate: () => {}, onInjected: (stretch) => injected.push(stretch) })

  it('a live session whose model says names into the quiet types only what was said', async () => {
    live = await startFakeLive((connection, message) => {
      if ('setup' in message) {
        connection.send({ setupComplete: {} })
        return
      }
      const input = message['realtimeInput'] as Record<string, unknown> | undefined
      if (input?.['audio'] !== undefined && connection.received.length === 2) {
        // Silence first: the biased model fills it with names, alone and glued to a full stop.
        connection.send({ serverContent: { inputTranscription: { text: 'Cosmiprint.' } } })
        connection.send({ serverContent: { inputTranscription: { text: ' The weather is nice today.' } } })
        connection.send({ serverContent: { inputTranscription: { text: ' Strat Edge.Impetix' } } })
      }
      if (input?.['audioStreamEnd'] === true) setTimeout(() => connection.send({ serverContent: { turnComplete: true } }), 30)
    })
    const injected: string[] = []
    const transcriber = session(live.url, injected)
    await transcriber.start()
    transcriber.audio(Buffer.alloc(3200))
    await new Promise((resolve) => setTimeout(resolve, 120))
    const text = await transcriber.finish(2000)
    expect(text).toBe('The weather is nice today.')
    for (const name of NAMES) expect(text).not.toContain(name)
    expect(injected).toEqual(['Cosmiprint.', 'Strat Edge.', 'Impetix'])
  })

  it('a replayed recording of silence gives no words at all', async () => {
    live = await startFakeLive((connection, message) => {
      if ('setup' in message) connection.send({ setupComplete: {} })
      const input = message['realtimeInput'] as Record<string, unknown> | undefined
      if (input?.['audioStreamEnd'] === true) {
        connection.send({ serverContent: { inputTranscription: { text: 'Cosmiprint.' } } })
        setTimeout(() => connection.send({ serverContent: { turnComplete: true } }), 30)
      }
    })
    const text = await replayRecording({ url: live.url, key: 'k', model: 'm', socket: nodeSocket, vocabulary: NAMES, pcm: Buffer.alloc(3200 * 3), signal: new AbortController().signal })
    expect(text).toBe('')
  })
})

describe('names are spelled right after transcription, only for words that were said', () => {
  const names = ['Cosmiprint', 'Initech', 'Mokoena', 'Finance', 'Impetix', 'GrowFactory', 'Northwind TVET College']

  it('respells a close mis-hearing and leaves different words alone', () => {
    expect(soundsLike('Cosmic print', 'Cosmiprint')).toBe(true)
    expect(soundsLike('Initeck', 'Initech')).toBe(true)
    expect(soundsLike('Mo Kena', 'Mokoena')).toBe(true)
    expect(soundsLike('Cosmic shows', 'Cosmiprint')).toBe(false)
    expect(respellNames('Email Initeck and Mo Kena about Impetics.', names).text).toBe('Email Initech and Mokoena about Impetix.')
    // An ordinary word, another form of a name, or a name already right: as said.
    expect(respellNames('Finances are tight, finance is late, Finance is fine.', names).text).toBe('Finances are tight, finance is late, Finance is fine.')
    // Heard in lower case and split in two, it is still his name; one ordinary lower-case word is not.
    expect(respellNames("I don't know why that thing saying cosmic print there.", names).text).toBe("I don't know why that thing saying Cosmiprint there.")
    expect(respellNames('the impetics file', names).text).toBe('the impetics file')
    // A name of several words is not made out of an ordinary phrase that shares its first words.
    expect(respellNames('Can you do the Strat Edge sync tonight?', [...names, 'Strat Edge Slack']).text).toBe('Can you do the Strat Edge sync tonight?')
    // A name never brings in more words than were heard.
    expect(respellNames('Northwind sent it.', names).text).toBe('Northwind sent it.')
  })

  it('his 17:50 dictation heard as said: the two times he said it are spelled right, the unclear words stay his', () => {
    // 20261029-175032-8743 through the live model with no name list (29 Oct 2026, test copy).
    const heard =
      "Somehow integrate that within the application instead of havingYeah, yeah, yeah, Cosmic shows like we're wasting real estate with that tab saying calendar. " +
      "Oh, I really don't know why that thing saying calling Cosmic print there. Like that calling me print was not me before here before I mentioned Cosmic print, that was not me."
    const fixed = respellNames(heard, names)
    expect(fixed.text.match(/Cosmiprint/g)?.length).toBe(2)
    expect(fixed.text).toContain('Yeah, yeah, yeah, Cosmic shows like')
    expect(fixed.changed).toEqual([{ heard: 'Cosmic print', name: 'Cosmiprint' }, { heard: 'Cosmic print', name: 'Cosmiprint' }])
  })

  it('his 17:50 dictation as 0.2.104 typed it: the injected name is gone and his own words are back', () => {
    // The composer mic in a 0.2.104 test copy, his recording as the microphone (29 Oct 2026).
    const typed = "Yeah, yeah, yeah, because it's like a wasting real estate with that tab saying calendar. Oh, and I really don't know why that thing saying cosmic print there."
    const fixed = respellNames(stripInjectedNames(typed, names).text, names).text
    expect(fixed).toBe("Yeah, yeah, yeah, because it's like a wasting real estate with that tab saying calendar. Oh, and I really don't know why that thing saying Cosmiprint there.")
  })

  it('no recogniser is biased with names any more: not the live session, not a replay, not the one-call transcription', () => {
    const setup = readFileSync(join(__dirname, '../src/main/dictation/setup.ts'), 'utf8')
    expect(setup).not.toMatch(/vocabulary:\s*(\(\)\s*=>\s*)?(words|names)/)
    expect(setup).not.toMatch(/transcribe\([^)]*names/)
    expect(setup).toContain('respellNames(text, names)')
  })
})
