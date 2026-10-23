/**
 * The folder a plan run works in. A project chat and every helper it starts work in the project's folder: the
 * engine (Claude Code or Codex) runs there, so its shell, relative paths and its own idea of its workspace point at
 * the project instead of the chat's private folder in the app's data. Everything else has no folder of its own.
 */
import { statSync } from 'node:fs'

/** The project folder a chat's work is in: its project's folder, '' when the chat is in none or it has none. */
export function projectFolderOf(projects: ReadonlyArray<{ chats: readonly string[]; path: string }>, chat: string | undefined): string {
  if (chat === undefined || chat === '') return ''
  return projects.find((each) => each.chats.includes(chat))?.path.trim() ?? ''
}

/** The folder an engine may run in: the project folder when it is a folder on this computer, else none. */
export function usableFolder(folder: string | undefined, isDir: (path: string) => boolean = isDirectory): string | undefined {
  const value = folder?.trim() ?? ''
  return value !== '' && isDir(value) ? value : undefined
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
