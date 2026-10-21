/**
 * Where a chat lives, for anything that shows a row from any chat (the approvals panel in the side bar): the main
 * thread, or a project with its icon and name. The signature is a contract with the side panel; keep it.
 */
import type { ChatItem, ProjectIcon, ProjectRow } from '@agent/core'

import { projectOfChat } from './projects'

export function sourceOfChat(
  chatId: string,
  items: ChatItem[],
  projects: ProjectRow[],
): { kind: 'main' | 'project'; name: string; icon: ProjectIcon | null; projectId: string | null } {
  void items
  const project = projectOfChat(projects, chatId)
  if (project === null) return { kind: 'main', name: 'Main chat', icon: null, projectId: null }
  return { kind: 'project', name: project.name, icon: project.icon, projectId: project.id }
}
