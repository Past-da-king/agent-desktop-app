/**
 * Where a chat lives, for anything that shows a row from any chat (the approvals panel in the side bar): the main
 * thread, or a project with its icon and name. The signature is a contract with the side panel; keep it.
 */
import type { ChatItem, ProjectIcon, ProjectRow } from '@agent/core'

import { projectOfChat } from './projects'

/** Where one waiting row comes from. */
export interface ChatSource {
  kind: 'main' | 'project'
  name: string
  icon: ProjectIcon | null
  projectId: string | null
}

export function sourceOfChat(
  chatId: string,
  items: ChatItem[],
  projects: ProjectRow[],
  /** The main agent's name, for rows from the main thread. */
  agentName = 'Main chat',
): ChatSource {
  void items
  const project = projectOfChat(projects, chatId)
  if (project === null) return { kind: 'main', name: agentName, icon: null, projectId: null }
  return { kind: 'project', name: project.name, icon: project.icon, projectId: project.id }
}
