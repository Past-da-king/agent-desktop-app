/**
 * The mini-apps he pinned, on the sidebar between the navigation and Projects (docs/plans/mini-apps.md). The 0.2.79
 * rule holds: the navigation, Settings and the account never shrink. This area asks for the room its pinned apps need
 * at full size and gives it up first: the tiles drop to the small size, then the ones that do not fit (and any past
 * the cap in Settings) go into a "+N" tile that opens the Apps page. Drag to reorder; right-click for more.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react'

import { agent } from '../bridge'
import { orTell } from '../lib/tell'
import { fitPinned, pinnedBasis } from '../lib/miniapps'
import { RAIL_PAD_SMALL, RAIL_TILE, RAIL_TILE_SMALL, type RailRoom } from '../lib/projects'
import { useEntity } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { useRoute, useUi } from '../state/useUi'
import { Icon } from '../ui/Icon'
import { MiniAppTile } from '../ui/MiniAppIcon'
import { pinnedApps, MINIAPP_PIN_CAP_DEFAULT } from '../../shared/miniapps'

export function PinnedApps({ collapsed }: { collapsed: boolean }): JSX.Element | null {
  const apps = useEntity('miniapp')
  const cap = useSettings((state) => state.settings?.miniappPinCap ?? MINIAPP_PIN_CAP_DEFAULT)
  const route = useRoute()
  const navigate = useUi((state) => state.navigate)
  const pinned = useMemo(() => pinnedApps(apps), [apps])
  const box = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState<RailRoom | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [drag, setDrag] = useState<string | null>(null)

  useLayoutEffect(() => {
    const node = box.current
    if (node === null) return undefined
    const measure = (): void => {
      const style = getComputedStyle(node)
      const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      const cols = style.gridTemplateColumns.split(' ').filter(Boolean).length || 1
      const gap = parseFloat(style.rowGap) || 0
      const item = node.querySelector<HTMLElement>('.pj-app')
      const tile = item?.querySelector<HTMLElement>('.pj-tile')
      let extra = 0
      if (item && tile) {
        const own = getComputedStyle(item)
        extra = Math.max(0, item.offsetHeight - tile.offsetHeight - parseFloat(own.paddingTop) - parseFloat(own.paddingBottom))
      }
      setRoom((prev) => {
        const next = { room: Math.max(0, node.clientHeight - pad), cols, gap, extra: prev !== null && item === null ? prev.extra : extra }
        return prev !== null && prev.room === next.room && prev.cols === next.cols && prev.gap === next.gap && prev.extra === next.extra ? prev : next
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [collapsed, pinned.length > 0])

  if (pinned.length === 0) return null
  const fit = fitPinned(room, pinned.length, cap)
  const shown = pinned.slice(0, fit.show)
  const size = fit.small ? RAIL_TILE_SMALL : RAIL_TILE
  // What it asks for: every pinned app at full size. It shrinks from there; Projects and the navigation keep theirs.
  const basis = pinnedBasis(pinned.length, cap, room?.cols ?? (collapsed ? 1 : 3), room?.extra ?? 18, room?.gap ?? 6, 4)

  const drop = (target: string): void => {
    if (drag === null || drag === target) return
    const ids = pinned.map((app) => app.id).filter((id) => id !== drag)
    ids.splice(ids.indexOf(target), 0, drag)
    setDrag(null)
    void orTell(agent.miniapps.order(ids), 'The order could not be saved.')
  }

  return (
    <>
      <div className="eyebrow mute grp ma-rail-h">
        <span>APPS</span>
      </div>
      <div
        ref={box}
        className={`pj-rail ma-rail${fit.small ? ' small' : ''}`}
        aria-label="Pinned apps"
        style={{ flexBasis: basis, minHeight: RAIL_PAD_SMALL + RAIL_TILE_SMALL + 4 }}
      >
        {shown.map((app) => {
          const on = route.page === 'miniapp' && route.id === app.id
          return (
            <button
              key={app.id}
              type="button"
              className={`pj-app${on ? ' on' : ''}${drag === app.id ? ' dragging' : ''}`}
              title={app.description ? `${app.name}. ${app.description}` : app.name}
              aria-current={on ? 'true' : undefined}
              draggable
              onDragStart={() => setDrag(app.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => drop(app.id)}
              onDragEnd={() => setDrag(null)}
              onClick={() => navigate({ page: 'miniapp', id: app.id })}
              onContextMenu={(event) => {
                event.preventDefault()
                setMenu({ id: app.id, x: event.clientX, y: event.clientY })
              }}
            >
              <MiniAppTile icon={app.icon} size={size} />
              <span className="pj-app-name">{app.name}</span>
            </button>
          )
        })}
        {fit.more > 0 ? (
          <button type="button" className="pj-app add" title={`${fit.more} more pinned apps`} aria-label={`All apps, ${fit.more} more pinned`} onClick={() => navigate({ page: 'apps' })}>
            <span className="pj-tile pj-add" aria-hidden="true">
              <span className="pj-more ma-more">+{fit.more}</span>
            </span>
            <span className="pj-app-name">More</span>
          </button>
        ) : null}
      </div>
      {menu !== null ? (
        <RailMenu
          {...menu}
          place={pinned.findIndex((app) => app.id === menu.id) + 1}
          count={pinned.length}
          onClose={() => setMenu(null)}
          onOpen={() => navigate({ page: 'miniapp', id: menu.id })}
        />
      ) : null}
    </>
  )
}

function RailMenu({ id, x, y, place, count, onClose, onOpen }: { id: string; x: number; y: number; place: number; count: number; onClose: () => void; onOpen: () => void }): JSX.Element {
  const act = (run: () => void): void => {
    onClose()
    run()
  }
  return (
    <div className="ma-ctx-scrim" onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose() }}>
      <div className="ma-menu ma-ctx" role="menu" style={{ left: x, top: y }} onClick={(event) => event.stopPropagation()}>
        <button type="button" role="menuitem" onClick={() => act(onOpen)}>
          <Icon name="play" size={16} /> Open
        </button>
        <button type="button" role="menuitem" className="flip" disabled={place <= 1} onClick={() => act(() => void orTell(agent.miniapps.pin(id, place - 1), 'It could not be moved.'))}>
          <Icon name="chevd" size={16} /> Move up
        </button>
        <button type="button" role="menuitem" disabled={place >= count} onClick={() => act(() => void orTell(agent.miniapps.pin(id, place + 1), 'It could not be moved.'))}>
          <Icon name="chevd" size={16} /> Move down
        </button>
        <button type="button" role="menuitem" onClick={() => act(() => void orTell(agent.miniapps.unpin(id), 'It could not be unpinned.'))}>
          <Icon name="pin" size={16} /> Unpin
        </button>
      </div>
    </div>
  )
}
