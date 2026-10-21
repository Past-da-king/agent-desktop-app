import { agent } from '../bridge'
import { useUi } from '../state/useUi'
import { isDivider } from './thread'

/**
 * Start a fresh stretch of conversation. History is never deleted: a small notice row marks the
 * boundary, the way the phone scrolls to a new divider instead of archiving the chat. The chat before it
 * leaves the agent's context and is saved into memory in the background.
 */
export async function startNewChat(): Promise<void> {
  const ui = useUi.getState()
  ui.navigate({ page: 'chat' })
  ui.focusComposer()
  try {
    // The main process writes the divider, takes the old chat out of context and files it into memory in the
    // background (main/memory/service.ts). This returns at once.
    await agent.memory.newChat()
    ui.scrollChat()
    return
  } catch {
    // An older main process without memory: fall back to a plain divider below.
  }
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
