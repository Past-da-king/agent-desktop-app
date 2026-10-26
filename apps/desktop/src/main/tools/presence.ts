/**
 * meeting_ended: he says a meeting is over (often in answer to the one "is it still on?" the presence note offers).
 * The meeting is marked ended, its follow-up job runs in two minutes instead of at its usual time (once), and the
 * internal "meeting.ended_early" event goes out. See presence/presence.ts.
 */
import { schema, str, type Tool } from '@agent/core'

export interface MeetingEndedHost {
  meetingEnded(query: { eventId?: string; title?: string }, how?: 'said' | 'inferred'): Promise<string>
}

export function presenceTools(host: MeetingEndedHost): Tool[] {
  return [
    {
      spec: {
        name: 'meeting_ended',
        description:
          "The user says a meeting is over (it ended early, or he left it). Marks it ended and brings its follow-up job forward to run in two minutes, once. Leave both out for the meeting on now; give the title when he names one. Call it only on his word, not on a guess.",
        schema: schema([], {
          title: str('The meeting, as he or the presence note names it. Leave out for the one on now'),
          event_id: str('The calendar event id, when you have it'),
        }),
      },
      run: async (input, ctx) => {
        const title = typeof input['title'] === 'string' ? input['title'] : undefined
        const eventId = typeof input['event_id'] === 'string' ? input['event_id'] : undefined
        const result = await host.meetingEnded({ ...(title === undefined ? {} : { title }), ...(eventId === undefined ? {} : { eventId }) }, 'said')
        await ctx.activity(`Meeting over: ${title ?? 'the one on now'}`, { tool: 'meeting_ended' })
        return result
      },
    },
  ]
}
