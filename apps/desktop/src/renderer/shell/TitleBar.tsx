import { agent } from '../bridge'
import { isDarkNow } from '../state/theme'
import { useAccountStatus } from '../state/useAccount'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { usePanel } from '../state/usePanel'
import { timeAgo } from '../lib/format'
import { Icon } from '../ui/Icon'
import { Mascot } from '../ui/Mascot'
import { BackButton, WorkButton } from './WorkMenu'

function syncCopy(signedIn: boolean, syncing: boolean, error: string | null, lastSyncedAt: number | null): string {
  if (!signedIn) return 'This computer only'
  if (syncing) return 'Syncing'
  if (error) return 'Offline, will sync later'
  if (lastSyncedAt === null) return 'Not synced yet'
  const ago = timeAgo(lastSyncedAt)
  return ago === 'now' ? 'Synced just now' : `Synced ${ago}`
}

export function TitleBar({ onboarding = false }: { onboarding?: boolean }): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const status = useAccountStatus()
  const openPalette = useUi((state) => state.openPalette)
  const panelCollapsed = usePanel((state) => state.collapsed)
  const togglePanel = usePanel((state) => state.toggle)

  const agentName = settings?.agentName.trim() || 'your agent'
  const dark = isDarkNow()
  const modKey = agent.platform === 'darwin' ? 'Cmd K' : 'Ctrl K'
  // On another device the window shows the computer it is linked to; that computer's sync is its own business.
  const remote = agent.remote
  const label = remote !== undefined ? `On ${remote.nodeName}` : syncCopy(status.signedIn, status.syncing, status.error, status.lastSyncedAt)
  const dotClass = remote !== undefined ? 'dot' : !status.signedIn || status.error ? 'dot off' : status.syncing ? 'dot busy' : 'dot'

  const switchTheme = (): void => {
    void save({ theme: dark ? 'light' : 'dark' })
  }

  return (
    <header className="titlebar">
      <div className="tb-brand">
        <Mascot id={settings?.mascot ?? 'scout'} size={24} />
        <span>Agent</span>
      </div>

      {onboarding ? null : <BackButton />}

      {onboarding ? (
        <div style={{ flex: 1 }} />
      ) : (
        <button type="button" className="cmdbar" onClick={openPalette} aria-label="Search or ask">
          <Icon name="search" size={18} />
          <span>Search, jump to, or ask {agentName}</span>
          <kbd>{modKey}</kbd>
        </button>
      )}

      <div className="tb-right">
        {onboarding ? null : (
          <>
            <WorkButton />
            <div className="syncpill" title="Sync status">
              <i className={dotClass} />
              {label}
            </div>
            <button
              type="button"
              className="tb-btn hide-m tb-panel"
              aria-label={panelCollapsed ? 'Open the side panel' : 'Collapse the side panel'}
              aria-pressed={panelCollapsed}
              onClick={togglePanel}
            >
              <Icon name="panel" size={20} />
            </button>
          </>
        )}
        <button type="button" className="tb-btn" aria-label="Switch light and dark" onClick={switchTheme}>
          <Icon name={dark ? 'sun' : 'moon'} size={20} />
        </button>
        <button type="button" className="wc" aria-label="Minimise" onClick={() => agent.window.minimize()}>
          <Icon name="min" size={18} />
        </button>
        <button type="button" className="wc" aria-label="Maximise" onClick={() => agent.window.toggleMaximize()}>
          <Icon name="max" size={16} />
        </button>
        <button type="button" className="wc close" aria-label="Close" onClick={() => agent.window.close()}>
          <Icon name="x" size={18} />
        </button>
      </div>
    </header>
  )
}
