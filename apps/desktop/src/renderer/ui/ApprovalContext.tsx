import React from 'react'
import { parseRequestSource } from '../../shared/request-source'
import { useSettings } from '../state/useSettings'

/** Expand to read the complete original request. Dates use the viewer's timezone. */
export function ApprovalContext({ meta }: { meta: Record<string, unknown> }): JSX.Element | null {
  const name = useSettings((state) => state.settings?.agentName.trim()) || 'Your agent'
  const request = parseRequestSource(meta.request)
  const recommendation = typeof meta.escalatedWhy === 'string' ? meta.escalatedWhy.trim() : ''
  if (!request && !recommendation) return null
  const label = request ? `You asked for this at ${new Date(request.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}: "${request.text}"` : ''
  return <div className="approval-context small muted">
    {request ? <details><summary title={label}>{label}</summary><div>{request.text}</div></details> : null}
    {recommendation ? <div>{name} recommends: {recommendation}</div> : null}
  </div>
}
