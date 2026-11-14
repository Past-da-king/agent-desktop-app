/**
 * A page handed to the agent from the browser lands in the message box of the chat that is open: its note and its
 * picture as chips, the box focused, so the person types what they want done with it. In the browser view the chat
 * opens beside the page; from the side panel's card the chat page is already there.
 */
import type { Attachment, BrowserHandOver } from '@agent/core'
import { useEffect } from 'react'

import { agent } from '../bridge'
import { useChats } from './useChats'
import { useDrafts } from './useDrafts'
import { useSettings } from './useSettings'
import { toast } from './useToast'
import { useUi } from './useUi'
import { useWorkspace } from './useWorkspace'

/** The files already in the box stay, and the same file is never added twice (a second press on the same page). */
export function addHandedFiles(have: Attachment[], incoming: Attachment[]): Attachment[] {
  const fresh = incoming.filter((file) => !have.some((held) => held.path === file.path))
  return fresh.length === 0 ? have : [...have, ...fresh]
}

/** What the person is told once the page is in the box. */
export function handOverToast(page: Pick<BrowserHandOver, 'title' | 'url' | 'problem'>, agentName: string): string {
  const what = page.title.trim() === '' ? 'The page' : page.title.trim().length > 48 ? `${page.title.trim().slice(0, 48).trim()}...` : page.title.trim()
  const base = `${what} is in your message. Say what ${agentName} should do with it.`
  return page.problem === '' ? base : `${base} No picture came with it: ${page.problem}`
}

export function takeHandOver(page: BrowserHandOver, browserView: boolean): void {
  const chat = useChats.getState().open
  const drafts = useDrafts.getState()
  drafts.setFiles(chat, addHandedFiles(drafts.files[chat] ?? [], page.attachments))
  if (browserView) useWorkspace.getState().setDockOpen(true)
  else useUi.getState().navigate({ page: 'chat' })
  useUi.getState().focusComposer()
  const agentName = useSettings.getState().settings?.agentName.trim() || 'your agent'
  toast(handOverToast(page, agentName))
}

export function useHandOver(): void {
  useEffect(
    () =>
      agent.browser.onHandOver((page) => {
        void agent.browser
          .state()
          .then((state) => takeHandOver(page, state.expanded === true && state.tabs.length > 0))
          .catch(() => takeHandOver(page, false))
      }),
    [],
  )
}
