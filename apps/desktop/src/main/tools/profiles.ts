/**
 * profile_create, for the MAIN agent only (reference phone tools/ProfileTools.kt). When none of the
 * person's profiles fits a job ("Job hunt": Gmail and LinkedIn), it makes one so every helper still
 * works inside a profile. It names apps, optionally narrowed to one account ("gmail:me@example.com");
 * it can only pick accounts that are really connected, never invent them.
 */
import { PROFILE_COLORS, schema, str, type ProfileAccount, type Tool } from '@agent/core'

import { appName } from '../apps/catalog'
import type { AppsService } from '../apps/service'
import { isProfileColor } from '../apps/profiles'
import type { LearnedStore } from '../apps/store'

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter((v) => v !== '') : []
}

export function profileTools(apps: AppsService | undefined, learned?: LearnedStore): Tool[] {
  if (apps === undefined) return []
  return [
    {
      spec: {
        name: 'profile_create',
        description:
          "Make a new profile when none of the user's fits a job: a name and the connected apps (and learned apps) its helpers may use. It shows in the user's Connections in its own colour and gets its own browser sign-ins. Then delegate with that profile.",
        schema: schema(['name'], {
          name: str("Short name for this part of their life, e.g. 'Job hunt'"),
          apps: {
            type: 'array',
            items: { type: 'string' },
            description: "Connected apps it may use, by slug, e.g. 'gmail', or 'gmail:me@example.com' for one account. Leave out for none.",
          },
          learned: { type: 'array', items: { type: 'string' }, description: 'Learned apps (from webapp_list) it may run, by id or name.' },
          color: str(`Optional colour: ${PROFILE_COLORS.filter((c) => c !== 'graphite').join(', ')}`),
        }),
      },
      run: async (input) => {
        const name = typeof input['name'] === 'string' ? input['name'] : ''
        const picked: ProfileAccount[] = []
        const missing: string[] = []
        for (const wanted of strings(input['apps'])) {
          const at = wanted.indexOf(':')
          const slug = (at < 0 ? wanted : wanted.slice(0, at)).trim().toLowerCase()
          const who = at < 0 ? '' : wanted.slice(at + 1).trim().toLowerCase()
          let found: ProfileAccount[] = []
          try {
            found = (await apps.activeAccounts([slug]))
              .filter((a) => a.app.toLowerCase() === slug && (who === '' || a.label.toLowerCase() === who || a.id === who))
              .map((a) => ({ id: a.id, app: a.app, label: a.label }))
          } catch {
            found = []
          }
          if (found.length === 0) missing.push(wanted)
          else picked.push(...found)
        }
        const learnedIds: string[] = []
        for (const wanted of strings(input['learned'])) {
          const app = learned?.find(wanted) ?? null
          if (app === null) missing.push(wanted)
          else learnedIds.push(app.id)
        }
        const color = isProfileColor(input['color']) && input['color'] !== 'graphite' ? input['color'] : undefined
        const made = apps.profiles.create(name, picked, color, '', learnedIds)
        if (!made.ok) return made.message.startsWith('There is already') ? `${made.message} Use it.` : made.message
        const p = made.value
        const has = p.accounts.length === 0 ? 'no accounts' : p.accounts.map((a) => `${appName(a.app)} ${a.label}`).join(', ')
        return (
          `Made the profile ${p.name} with ${has}${p.learned.length > 0 ? ` and ${p.learned.length} learned app(s)` : ''}.` +
          (missing.length > 0 ? ` Not connected, so left out: ${missing.join(', ')}.` : '') +
          ` Delegate with profile "${p.name}".`
        )
      },
    },
  ]
}
