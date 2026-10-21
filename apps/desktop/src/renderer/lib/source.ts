import type { ChatItem } from '@agent/core'

/** A project's icon: a glyph from the app's icon set (or an emoji) on a coloured tile. */
export type ProjectIcon = { glyph: string; color: string }

export interface ChatSource {
  kind: 'main' | 'project'
  name: string
  icon: ProjectIcon | null
  projectId: string | null
}

/**
 * Where a chat belongs: the main thread (shown with the agent's own name) or a project. A stub until Projects
 * land: every chat is the main agent's. The Projects branch replaces this file with the same signature.
 */
export function sourceOfChat(_chatId: string, _items: ChatItem[], _projects: unknown[], agentName = 'Your agent'): ChatSource {
  return { kind: 'main', name: agentName, icon: null, projectId: null }
}
