/**
 * The Settings page as data: the ten sections in order and one row per setting key (4 Nov 2026, the redesign).
 *
 * Every key in DEFAULT_SETTINGS has exactly one row here, with the label and the one-line description the person
 * reads, the control that suits the value, and a sample value that is not the default (the round trip test in
 * apps/desktop/test/settings-redesign.test.ts saves every sample and reads it back). The page draws these rows; the
 * search box searches them; the rail counts them. Nothing here touches the app or the network, so a test can read it.
 *
 * Labels: sentence case, no full stops, no jargon. Descriptions: one sentence, plain English, ending in a full stop.
 * The default is not written here: the row adds "Default: x" and a Reset button only while the value is not it.
 */
import { DEFAULT_SETTINGS } from '@agent/core'

import type { IconName } from '../../ui/Icon'

/** The ten sections, in the order they appear in the rail. `hidden` sections appear only while Developer settings is on. */
export type SectionId = 'account' | 'profiles' | 'devices' | 'agents' | 'voice' | 'notify' | 'appearance' | 'privacy' | 'git' | 'advanced'

export interface SectionSpec {
  id: SectionId
  name: string
  /** The line under the section name: what the section is for. */
  line: string
  icon: IconName
  hidden?: boolean
}

/** The one new key of the redesign: it shows the two hidden sections and changes nothing else. */
export const DEVELOPER_KEY = 'showDeveloperSettings'

export const SECTIONS: readonly SectionSpec[] = [
  { id: 'account', name: 'Account and AI', line: 'Who you are, who your agent is, and what it thinks with.', icon: 'person' },
  { id: 'profiles', name: 'Profiles and connections', line: 'Where your accounts live. They are kept on the Connections page.', icon: 'grid' },
  { id: 'devices', name: 'Devices', line: 'Your phone and other computers, one agent.', icon: 'server' },
  { id: 'agents', name: 'Agents and helpers', line: 'What helpers think with, how many work at once, and whether the app keeps running.', icon: 'bolt' },
  { id: 'voice', name: 'Voice and dictation', line: 'Talk to your agent, dictate anywhere, and hear replies.', icon: 'mic' },
  { id: 'notify', name: 'Notifications and wake-ups', line: 'When something needs you now, your devices ring until you answer.', icon: 'bell' },
  { id: 'appearance', name: 'Appearance', line: 'Light, dark or the same as your computer, your colour, your sidekick.', icon: 'palette' },
  { id: 'privacy', name: 'Privacy and data', line: 'What your agent may touch on this computer, and what is kept.', icon: 'shield' },
  { id: 'git', name: 'Git and developer', line: 'What is committed and pushed after a run.', icon: 'branch', hidden: true },
  { id: 'advanced', name: 'Advanced', line: 'Shortcuts, the sync server and the stored values.', icon: 'sliders', hidden: true },
]

/**
 * The control a row gets. One control per kind of value (structure.md): a switch for on or off, a segmented control
 * for two to four choices, a select for more, a field for text, a number for a count, a slider only for a real range.
 * `block` is a group of rows drawn by its own component (the AI accounts, the device list, the folders).
 */
export type ControlKind =
  | 'switch'
  | 'segmented'
  | 'select'
  | 'field'
  | 'number'
  | 'time'
  | 'datetime'
  | 'slider'
  | 'hotkey'
  | 'swatches'
  | 'mascots'
  | 'block'
  | 'readonly'

export interface RowSpec {
  /** The settings key. Never renamed: it is the name the store, the agent and the phone already use. */
  key: string
  section: SectionId
  label: string
  description: string
  control: ControlKind
  icon: IconName
  /** A value that is not the default, for the round trip test. */
  sample: unknown
  /** More words the search box matches (the label, the description, the key and the section name always match). */
  terms?: string[]
  /**
   * Never shows the default line or a Reset. A name has no default to go back to (this computer is called whatever the
   * computer is called), and a group of rows is not something one button should empty.
   */
  quiet?: boolean
}

/** Every setting, one row each, in the order the page draws them. */
export const ROWS: readonly RowSpec[] = [
  // ---- Account and AI ----
  { key: 'userName', section: 'account', label: 'Your name', description: 'What your agent calls you, on the rail and in its replies.', control: 'field', icon: 'person', sample: 'Sam' },
  { key: 'agentName', section: 'account', label: "Your agent's name", description: 'The name on the rail, in chat and in its replies.', control: 'field', icon: 'bolt', sample: 'Nova' },
  { key: 'syncEmail', section: 'account', label: 'Signed in as', description: 'The account this computer syncs with. Keys never sync.', control: 'readonly', icon: 'mail', sample: 'sam@example.com' },
  { key: 'signedIn', section: 'account', label: 'Sync status', description: 'Whether this computer is signed in, and when it last synced. Each device keeps its own keys.', control: 'readonly', icon: 'link', sample: true },
  { key: 'accounts', section: 'account', label: 'AI accounts', description: 'The plans and keys your agent may think with.', control: 'block', icon: 'key', sample: [{ id: 'work', label: 'Work key', kind: 'api', provider: 'openai', model: 'gpt-5.1', hasKey: true }], terms: ['openai', 'anthropic', 'gemini', 'plan', 'api'] },
  { key: 'ai', section: 'account', label: 'What thinks in the main chat', description: 'The account and model that answer in chat. Helpers can use another.', control: 'block', icon: 'sliders', sample: { main: { account: 'work', model: 'gpt-5.1' }, helpers: { account: '', model: '' } }, terms: ['model', 'brain', 'thinking'] },

  // ---- Devices ----
  { key: 'deviceName', section: 'devices', label: "This computer's name", description: 'What your other devices call this computer in the device list.', control: 'field', icon: 'monitor', sample: 'Studio PC', quiet: true, terms: ['hostname', 'rename'] },
  { key: 'devicesShareGroups', section: 'devices', label: 'What your other devices may use here', description: "Each group of this computer's tools your phone and other computers may reach.", control: 'block', icon: 'server', sample: { browser: true, files: true }, terms: ['share', 'browser', 'files', 'commands'] },
  { key: 'devicesPreferred', section: 'devices', label: 'Preferred device for each shared tool', description: 'Which of your devices is used first for the browser, files or commands.', control: 'select', icon: 'link', sample: { browser: 'phone-1' }, terms: ['first', 'pick'] },
  { key: 'devicesJobLimit', section: 'devices', label: 'Work for your other devices', description: 'How many helpers this computer runs for your other devices at once. No limit unless you pick one.', control: 'select', icon: 'sliders', sample: 4, terms: ['helpers', 'limit'] },

  // ---- Agents and helpers ----
  { key: 'helpersAtOnce', section: 'agents', label: 'Helpers at once', description: 'How many helpers work at the same time here. The rest wait their turn.', control: 'number', icon: 'person', sample: 3, terms: ['parallel', 'limit'] },
  { key: 'helperMaxSteps', section: 'agents', label: 'Steps per helper', description: 'A step is one tool call or one model reply. A helper stops and says so after this many.', control: 'number', icon: 'sliders', sample: 40, terms: ['iterations', 'limit'] },
  { key: 'routinesAtOnce', section: 'agents', label: 'Routines at once', description: 'How many routine desks work at the same time.', control: 'number', icon: 'clock', sample: 2, terms: ['desks', 'limit'] },
  { key: 'helperQuietMinutes', section: 'agents', label: 'Heads-up on a quiet helper', description: 'You hear once when a helper takes no new step for this long.', control: 'select', icon: 'bell', sample: 15, terms: ['stuck', 'rate limit'] },
  { key: 'helperMinFreeRamGb', section: 'agents', label: 'Pause helpers when memory is low', description: 'New helpers wait while free memory is under this. One still runs.', control: 'number', icon: 'sliders', sample: 2.5, terms: ['ram', 'memory'] },
  { key: 'helperMinFreeDiskGb', section: 'agents', label: 'Pause helpers when disk is low', description: 'New helpers wait while the app drive has less free space than this.', control: 'number', icon: 'file', sample: 9.5, terms: ['disk', 'space'] },
  { key: 'helperBusyCpu', section: 'agents', label: 'Send work elsewhere when this computer is busy', description: 'Above this processor use, work that does not need this computer goes to a linked server.', control: 'number', icon: 'sliders', sample: 70, terms: ['cpu', 'processor', 'busy'] },
  { key: 'helpersRunOn', section: 'agents', label: 'Run helpers on', description: 'Best sends work that does not need this computer to a linked server.', control: 'segmented', icon: 'server', sample: 'here', terms: ['brain', 'where'] },
  { key: 'launchAtLogin', section: 'agents', label: 'Start when I sign in', description: 'So routines run without you opening anything.', control: 'switch', icon: 'play', sample: true, terms: ['login', 'startup'] },
  { key: 'closeToTray', section: 'agents', label: 'Keep running in the tray', description: 'Closing the window does not stop routines.', control: 'switch', icon: 'panel', sample: false, terms: ['background'] },
  { key: 'dailyMemoryAt', section: 'agents', label: 'End of day memory pass', description: 'When your agent tidies memory each day. Empty turns it off. A routine in Routines can do it too.', control: 'time', icon: 'memory', sample: '21:15', terms: ['memory', 'evening', 'tidy'] },
  { key: 'guideModel', section: 'agents', label: 'Model that shows you how', description: 'Walks the steps on your screen when you ask to be shown how. Automatic picks the smallest fast model you have.', control: 'block', icon: 'bolt', sample: { account: 'a1b2c3d4', model: 'small-fast-model' }, terms: ['show me', 'guide', 'walk', 'steps', 'fast', 'small', 'screen'] },

  // ---- Voice and dictation ----
  { key: 'hasVoiceKey', section: 'voice', label: 'Voice key', description: 'Shows whether a Gemini key is stored. The key itself never appears here.', control: 'readonly', icon: 'key', sample: true, terms: ['gemini', 'key', 'stored'] },
  { key: 'voiceName', section: 'voice', label: 'Voice', description: 'Used on a call and when your replies are read aloud.', control: 'select', icon: 'sound', sample: 'Puck', terms: ['sound', 'speak'] },
  { key: 'speakReplies', section: 'voice', label: 'Voice note with every reply', description: 'Your agent records a short voice note as well as its text.', control: 'switch', icon: 'mic', sample: true, terms: ['audio', 'speak'] },
  { key: 'dictateHotkey', section: 'voice', label: 'Dictation shortcut', description: 'Types what you say where the cursor is, in any app. Press again to stop.', control: 'hotkey', icon: 'mic', sample: 'Alt+Shift+Space', terms: ['shortcut', 'accelerator', 'keys', 'type'] },
  { key: 'dictateCleanHotkey', section: 'voice', label: 'Clean-up dictation shortcut', description: 'The same, with fillers and false starts taken out. While dictating, this switches to it.', control: 'hotkey', icon: 'edit', sample: 'CommandOrControl+Alt+D', terms: ['shortcut', 'accelerator', 'keys', 'tidy'] },

  // ---- Notifications and wake-ups ----
  { key: 'notifications', section: 'notify', label: 'Desktop notifications', description: 'A system notification when your agent needs an answer.', control: 'switch', icon: 'bell', sample: false, terms: ['alert'] },
  { key: 'wakeupsRingHere', section: 'notify', label: 'Ring on this computer', description: 'A loud alarm and a full-screen screen on every display.', control: 'switch', icon: 'bell', sample: false, terms: ['alarm', 'ring'] },
  { key: 'wakeupsPauseHereUntil', section: 'notify', label: 'Pause ringing on this computer', description: 'Until a date and time. Your phone keeps ringing and it resumes by itself.', control: 'datetime', icon: 'clock', sample: '2026-12-01T18:00:00+02:00', terms: ['silence', 'quiet'] },
  { key: 'wakeupsPhoneOnlyWhenIdle', section: 'notify', label: 'Only the phone when this computer is idle or locked', description: 'If no phone confirms within 30 seconds, this computer rings anyway.', control: 'switch', icon: 'phone', sample: false, terms: ['away', 'locked'] },
  { key: 'wakeupsIdleMinutes', section: 'notify', label: 'Idle after', description: 'Minutes without input before this computer counts as idle.', control: 'select', icon: 'clock', sample: 10, terms: ['idle'] },
  { key: 'wakeupSnoozeMinutes', section: 'notify', label: 'Snooze', description: 'Rings again after this long, at the same severity.', control: 'select', icon: 'clock', sample: 10, terms: ['later'] },
  { key: 'wakeupQuietHours', section: 'notify', label: 'Quiet hours', description: 'Only a heads-up is silent then. Urgent and critical always ring.', control: 'select', icon: 'moon', sample: '23:00-06:00', terms: ['night', 'silent'] },
  { key: 'wakeupVolume', section: 'notify', label: 'Alarm volume', description: 'On this computer. Your phone uses its own alarm volume.', control: 'slider', icon: 'sound', sample: 0.6, terms: ['loud', 'volume'] },

  // ---- Appearance ----
  { key: 'theme', section: 'appearance', label: 'Theme', description: 'Light, dark, or the same as your computer.', control: 'segmented', icon: 'palette', sample: 'dark', terms: ['dark', 'light', 'look'] },
  { key: 'accent', section: 'appearance', label: 'Your colour', description: 'Buttons, links and highlights.', control: 'swatches', icon: 'palette', sample: 'ocean', terms: ['colour', 'color', 'accent'] },
  { key: 'mascot', section: 'appearance', label: 'Your sidekick', description: 'The character on Home and in the chat.', control: 'mascots', icon: 'heart', sample: 'ghost', terms: ['character', 'avatar'] },
  { key: 'miniappPinCap', section: 'appearance', label: 'Pinned apps in the sidebar', description: 'How many pinned apps the sidebar shows. The rest wait on the Apps page.', control: 'select', icon: 'pin', sample: 12, terms: ['pins', 'sidebar'] },

  // ---- Privacy and data ----
  { key: 'grantedFolders', section: 'privacy', label: 'Folders I can use', description: 'Read and write here without asking. Everywhere else your agent asks first.', control: 'block', icon: 'folder', sample: ['/home/sam/Documents'], terms: ['folders', 'files', 'allowed'] },
  { key: 'shell', section: 'privacy', label: 'Commands and code', description: 'Whether your agent may run commands and code here, and open files outside these folders.', control: 'segmented', icon: 'term', sample: 'never', terms: ['commands', 'code', 'terminal'] },
  { key: 'recordingAudioKeep', section: 'privacy', label: 'Keep recording audio', description: 'The sound of your recordings and dictations. The words are always kept.', control: 'select', icon: 'mic', sample: 'week', terms: ['recordings', 'audio', 'delete'] },
  { key: 'hideGuidesFromCapture', section: 'privacy', label: 'Hide guides from screen sharing', description: 'The highlight and its label are left out of Teams, Meet and Zoom, and you still see them.', control: 'switch', icon: 'shield', sample: false, terms: ['screen share', 'teams', 'meet', 'zoom', 'highlight', 'guide', 'capture', 'private'] },
  { key: 'hideChatFromCapture', section: 'privacy', label: 'Hide the chat from screen sharing', description: 'A window can only be hidden whole. While the chat is part of the app window, this hides the whole window.', control: 'switch', icon: 'shield', sample: true, terms: ['screen share', 'teams', 'meet', 'zoom', 'chat', 'capture', 'private'] },
  { key: DEVELOPER_KEY, section: 'privacy', label: 'Developer settings', description: 'Shows Git and developer and Advanced below. Leave it off unless you are building or debugging.', control: 'switch', icon: 'code', sample: true, terms: ['git', 'shortcut', 'developer', 'advanced', 'hidden'] },

  // ---- Git and developer (shown only while Developer settings is on) ----
  { key: 'gitAutoCommit', section: 'git', label: 'Commit after each run', description: 'Only the files that run changed, on the branch the project is on.', control: 'switch', icon: 'branch', sample: true, terms: ['commit', 'version'] },
  { key: 'gitAutoPush', section: 'git', label: 'Push after the commit', description: 'Does nothing while Commit after each run is off.', control: 'switch', icon: 'branch', sample: false, terms: ['push', 'github'] },
  { key: 'gitMaxFileMb', section: 'git', label: 'Biggest file', description: 'Files bigger than this are never committed.', control: 'select', icon: 'file', sample: 25, terms: ['size', 'large'] },
  { key: 'gitExclude', section: 'git', label: 'Also leave out', description: 'Patterns, comma separated: *.mp4, scratch/, data/**.', control: 'field', icon: 'file', sample: '*.mp4, scratch/', terms: ['ignore', 'exclude', 'patterns'] },

  // ---- Advanced (shown only while Developer settings is on) ----
  { key: 'quickAskHotkey', section: 'advanced', label: 'Quick chat shortcut', description: 'A small message box over any app. Enter sends, Esc closes.', control: 'hotkey', icon: 'bolt', sample: 'CommandOrControl+Alt+Right', terms: ['shortcut', 'accelerator', 'keys', 'quick'] },
  { key: 'showMeSkipHotkey', section: 'advanced', label: 'Skip a step shortcut', description: 'While you are being shown how, this skips the step. Esc always stops.', control: 'hotkey', icon: 'bolt', sample: 'CommandOrControl+Alt+K', terms: ['shortcut', 'show me', 'guide', 'skip', 'next'] },
  { key: 'showMeDoneHotkey', section: 'advanced', label: 'I did it shortcut', description: 'While you are being shown how, this moves on when you did the step another way.', control: 'hotkey', icon: 'bolt', sample: 'CommandOrControl+Alt+J', terms: ['shortcut', 'show me', 'guide', 'done'] },
  { key: 'syncUrl', section: 'advanced', label: 'Sync server', description: 'Where your account lives. Empty means the default service.', control: 'field', icon: 'globe', sample: 'https://sync.example.com', terms: ['server', 'address', 'account'] },
  { key: 'watchdogMs', section: 'advanced', label: 'Log a frozen main thread', description: 'Writes the call stacks to main.log when the app stops responding for this long. 0 turns it off.', control: 'number', icon: 'doc', sample: 2000, terms: ['freeze', 'hang', 'log', 'slow'] },
  { key: 'mode', section: 'advanced', label: 'Legacy power mode', description: 'Kept for installs from before AI accounts. It follows your main account.', control: 'readonly', icon: 'key', sample: 'subscription', terms: ['stored'] },
  { key: 'cli', section: 'advanced', label: 'Legacy plan tool', description: 'Which installed plan the old single choice used. The account holds it now.', control: 'readonly', icon: 'term', sample: 'claude', terms: ['stored'] },
  { key: 'cliModel', section: 'advanced', label: 'Legacy plan model', description: 'The model the old plan choice stored. The account holds it now.', control: 'readonly', icon: 'sliders', sample: 'opus', terms: ['stored'] },
  { key: 'provider', section: 'advanced', label: 'Legacy provider', description: 'The provider the old single choice stored. The account holds it now.', control: 'readonly', icon: 'globe', sample: 'openai', terms: ['stored'] },
  { key: 'model', section: 'advanced', label: 'Legacy model', description: 'The model the old single choice stored. The account holds it now.', control: 'readonly', icon: 'sliders', sample: 'gpt-5.1', terms: ['stored'] },
  { key: 'hasKey', section: 'advanced', label: 'An API key is saved', description: 'Shows whether the old single API key exists. Each account reports its own now.', control: 'readonly', icon: 'key', sample: true, terms: ['stored'] },
  { key: 'baseUrl', section: 'advanced', label: 'Legacy server address', description: 'Only for the old custom provider. Custom accounts keep their own address.', control: 'readonly', icon: 'globe', sample: 'https://api.example.com', terms: ['stored', 'custom'] },
  { key: 'allowHttp', section: 'advanced', label: 'Legacy allow HTTP', description: 'Only for the old custom provider. Each custom account keeps its own switch.', control: 'readonly', icon: 'lock', sample: true, terms: ['stored', 'plain'] },
  { key: 'onboarded', section: 'advanced', label: 'Onboarding finished', description: 'Set once, when the first run finished. Read only.', control: 'readonly', icon: 'check', sample: true, terms: ['stored', 'first run'] },
]

export const ROW_BY_KEY: Readonly<Record<string, RowSpec>> = Object.fromEntries(ROWS.map((row) => [row.key, row]))

const SECTION_BY_ID: Readonly<Record<SectionId, SectionSpec>> = Object.fromEntries(SECTIONS.map((section) => [section.id, section])) as Record<SectionId, SectionSpec>

export function sectionOf(row: RowSpec): SectionSpec {
  return SECTION_BY_ID[row.section]
}

/** A section that only appears while Developer settings is on. */
export function isHidden(section: SectionSpec): boolean {
  return section.hidden === true
}

/** The value the row shows as its default, read from the one place defaults live. */
export function defaultOf(key: string): unknown {
  return (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key]
}

/** True when the value is the default: that is when the row stays quiet (no default line, no Reset). */
export function isDefault(spec: RowSpec, value: unknown): boolean {
  const base = defaultOf(spec.key)
  if (value === undefined) return true
  if (base === null) return value === null || value === ''
  if (typeof value === 'object' || typeof base === 'object') {
    return JSON.stringify(value ?? null) === JSON.stringify(base ?? null)
  }
  if (base === '') return value === ''
  return value === base
}

/** The rows inside one section, in order. */
export function rowsOfSection(id: SectionId): RowSpec[] {
  return ROWS.filter((row) => row.section === id)
}

export interface RailSection {
  section: SectionSpec
  /** How many settings the section holds. */
  count: number
  /** True when it is a section the Developer switch hides. */
  hidden: boolean
  /** True when a setting inside it is not at its default. */
  changed: boolean
}

/**
 * The rail, in order. The two developer sections are left out while Developer settings is off: they are not hidden
 * from search, only from the rail.
 */
export function railSections(showDeveloperSettings: boolean, settings?: Record<string, unknown> | null): RailSection[] {
  return SECTIONS.filter((section) => !isHidden(section) || showDeveloperSettings).map((section) => {
    const rows = rowsOfSection(section.id)
    return {
      section,
      count: rows.length,
      hidden: isHidden(section),
      changed: settings == null ? false : rows.some((row) => !isDefault(row, settings[row.key])),
    }
  })
}

/** The rows on the page: the same filter as the rail. */
export function visibleRows(showDeveloperSettings: boolean): RowSpec[] {
  return ROWS.filter((row) => showDeveloperSettings || !isHidden(sectionOf(row)))
}

export interface SearchHit {
  row: RowSpec
  section: SectionSpec
  /** True when the row sits in a section the Developer switch is hiding right now. */
  hidden: boolean
}

/** The words a row answers to: its label, its description, its key (also split into words), its section and its terms. */
export function wordsOf(row: RowSpec): string {
  const section = sectionOf(row)
  const keyWords = row.key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ')
  return [row.label, row.description, row.key, keyWords, section.name, ...(row.terms ?? [])].join(' ').toLowerCase()
}

/**
 * Every setting in every section, hidden ones too, as one flat list: each result carries its section, and says it is
 * hidden when the Developer switch is off. Every word typed must appear somewhere in the row, so "quiet hours"
 * finds Quiet hours and "git commit" finds Commit after each run.
 */
export function searchSettings(query: string, showDeveloperSettings = false): SearchHit[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word !== '')
  if (words.length === 0) return []
  const hits: SearchHit[] = []
  for (const row of ROWS) {
    const haystack = wordsOf(row)
    if (!words.every((word) => haystack.includes(word))) continue
    const section = sectionOf(row)
    hits.push({ row, section, hidden: isHidden(section) && !showDeveloperSettings })
  }
  return hits
}
