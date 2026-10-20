import { agent } from '../bridge'
import { useUi } from '../state/useUi'
import { isDivider } from './thread'

/**
 * Start a fresh stretch of conversation. History is never deleted: a small notice row marks the
 * boundary, the way the phone scrolls to a new divider instead of archiving the chat.
 */
export async function startNewChat(): Promise<void> {
  const ui = useUi.getState()
  ui.navigate({ page: 'chat' })
  ui.focusComposer()
  try {
    const rows = await agent.data.list('chat_item')
    const latest = rows.filter((item) => item.kind !== 'branch').sort((a, b) => b.createdAt - a.createdAt)[0]
    if (latest !== undefined && isDivider(latest)) {
      ui.scrollChat()
      return
    }
    await agent.data.upsert('chat_item', {
      kind: 'notice',
      text: 'New chat',
      meta: JSON.stringify({ divider: true, at: Date.now() }),
    })
    ui.scrollChat()
  } catch {
    // A local store that cannot write still gets the cursor in the composer; nothing is lost.
  }
}
