import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/main/db'
import { helperTools } from '../src/main/tools/helpers'
import type { HelperHost } from '../src/main/runtime/helpers'
import { projectTools } from '../src/main/tools/projects'
import { testContext, toolNamed } from './support'
const stores: Store[] = []
afterEach(() => stores.splice(0).forEach((s) => s.close()))
it('delegate records only the context request, ignoring one in model input', async () => {
 const delegate = vi.fn(async () => 'started')
 const host = { delegate } as unknown as HelperHost
 await toolNamed(helperTools(host), 'delegate').run({ tasks: [{ label: 'Check', brief: 'Read the drive' }], requestId: 'forged' }, testContext({ requestId: 'root' }))
 expect(delegate).toHaveBeenCalledWith(expect.any(Array), false, { requestId: 'root' })
})
it.each(['project_chat_start', 'project_chat_send'])('%s carries the pinned source instead of a newer unrelated request or model claim', async (name) => {
 const store = new Store(':memory:'); stores.push(store)
 const root = await store.upsert('chat_item', { kind: 'user', text: 'Pull the drive', meta: '{}' })
 await store.upsert('chat_item', { kind: 'user', text: 'Unrelated job', meta: '{}' })
 await store.upsert('project', { name: 'Example', chats: ['pc123456'] })
 const post = vi.fn(async () => undefined)
 const tools = projectTools({ store, post, state: () => ({ running: false, waiting: false }), agentName: () => 'Agent' })
 await toolNamed(tools, name).run({ project: 'Example', brief: 'Agent brief', chat: 'pc123456', message: 'Agent message', requestId: 'forged' }, testContext({ agentLabel: 'main', owner: 'main', requestId: root.id }))
 expect(post).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ requestId: root.id }))
})
