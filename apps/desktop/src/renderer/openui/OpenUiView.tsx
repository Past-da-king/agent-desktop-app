/**
 * An OpenUI Lang block drawn natively in React, in the app's own tokens (accent, dark mode, type), with no iframe
 * and no injected HTML. Re-parsed on every change, so a streaming answer builds up line by line.
 *
 * Ported from the phone app's ui/openui/OpenUiView.kt. The look: one tonal step per layer (card, then tiles inside
 * it), a cookie-shaped icon chip picked by keyword, one big figure per card when there is an amount, two-column fact
 * tiles or a grouped list, and big pill buttons that squash when pressed. A button tap goes to the agent quietly
 * and the button says Sent; follow-up chips send a visible message.
 */
import { Component, createContext, useContext, useMemo, useState, type ErrorInfo, type ReactNode } from 'react'

import { Markdown } from '../ui/Markdown'
import { iconForAction, iconForText, navigates, type UiIcon } from './icon-words'
import { IconChip, UiGlyph } from './icons'
import {
  actionsOf,
  buttonsLayout,
  cardTitle,
  factRows,
  factsLayout,
  fmt,
  fmtCount,
  fmtRating,
  GENERIC_HEADS,
  heroSplit,
  isNode,
  messageFor,
  renderSource,
  signOf,
  starKinds,
  type FactRow,
  type Scope,
  type UiNode,
} from './lang'

/** What taps on a generated card do. The chat provides all of them; elsewhere a card only opens links. */
export interface OpenUiHandlers {
  /** A follow-up chip: sent as the person's own visible message. */
  send?: (text: string) => void
  /** A button on the agent's card: goes to the agent quietly, as a button tap, never as a typed message. */
  act?: (label: string, message: string) => void
  /** Set where a button is an answer (a question the agent is waiting on): the button's own words answer it. */
  pick?: (text: string) => void
  openUrl?: (url: string) => void
  /** Taps already sent from this message (they survive a reload), by the message they sent. */
  tapped?: ReadonlySet<string>
}

const Handlers = createContext<OpenUiHandlers>({})

export function OpenUiProvider({ value, children }: { value: OpenUiHandlers; children: ReactNode }): JSX.Element {
  return <Handlers.Provider value={value}>{children}</Handlers.Provider>
}

/** What a component knows about where it sits: the card and item a tap is about, and the card's header figure. */
interface Cx {
  scope: Scope
  hero: string | null
  hint: string
  firstFacts: UiNode | null
}

const ROOT_CX: Cx = { scope: {}, hero: null, hint: '', firstFacts: null }

const str = (n: UiNode, k: string): string | null => {
  const v = n.props[k]
  return typeof v === 'string' ? v : null
}
const num = (n: UiNode, k: string): number | null => {
  const v = n.props[k]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
const list = (n: UiNode, k: string): unknown[] => {
  const v = n.props[k]
  return Array.isArray(v) ? v : []
}
const nodes = (n: UiNode, k: string): UiNode[] => list(n, k).filter(isNode)

/** Keeps one bad component from taking the thread down: it draws nothing instead. */
class Guard extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Shown as the fallback; a broken card is not worth a console error in the person's chat.
  }
  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function OpenUiBlock({ source, streaming = false }: { source: string; streaming?: boolean }): JSX.Element | null {
  const rendered = useMemo(() => renderSource(source), [source])
  const root = rendered.root
  if (root === null) {
    if (streaming) return <div className="oui-pending" role="status" aria-label="Drawing a card" />
    // A program that never drew anything: keep the words, never a blank or a crash.
    return source.trim() === '' ? null : <pre className="oui-raw">{source.trim()}</pre>
  }
  return (
    <Guard fallback={<pre className="oui-raw">{source.trim()}</pre>}>
      <div className="oui">
        <Comp n={root} cx={ROOT_CX} />
      </div>
    </Guard>
  )
}

function Comp({ n, cx }: { n: UiNode; cx: Cx }): JSX.Element | null {
  switch (n.type) {
    case 'Stack':
      return <StackComp n={n} cx={cx} />
    case 'Card':
      return <CardComp n={n} cx={cx} />
    case 'Product':
      return <ProductComp n={n} cx={cx} />
    case 'CardHeader':
      return <CardHeaderComp n={n} cx={cx} />
    case 'TextContent': {
      const text = str(n, 'text')
      if (text === null) return null
      const size = str(n, 'size') ?? 'default'
      return (
        <div className={`oui-text s-${size}`}>
          <Markdown text={text} />
        </div>
      )
    }
    case 'MarkDownRenderer': {
      const text = str(n, 'textMarkdown')
      return text === null ? null : (
        <div className={`oui-text md v-${str(n, 'variant') ?? 'clear'}`}>
          <Markdown text={text} />
        </div>
      )
    }
    case 'Callout':
      return <CalloutComp n={n} />
    case 'TextCallout':
      return <CalloutComp n={{ type: 'Callout', props: { ...n.props, variant: (str(n, 'variant') ?? 'neutral').replace('danger', 'error') } }} />
    case 'Separator':
      return <hr className="oui-sep" />
    case 'ImageBlock':
    case 'Image': {
      const src = str(n, 'src')
      return src === null ? null : <Picture src={src} alt={str(n, 'alt')} className="oui-img" />
    }
    case 'InlineHeader':
      return (
        <div className="oui-ih">
          {str(n, 'heading') !== null ? <div className="oui-ih-t">{str(n, 'heading')}</div> : null}
          {str(n, 'description') !== null ? <div className="oui-ih-d">{str(n, 'description')}</div> : null}
        </div>
      )
    case 'Icon':
      return <IconChip icon={iconForText(str(n, 'name')) ?? 'insights'} size={36} />
    case 'EntityList':
      return <EntityRows n={n} cx={cx} />
    case 'Table':
      return <TableComp cols={nodes(n, 'columns')} />
    case 'BarChart':
      return <Chart n={n} bars />
    case 'LineChart':
      return <Chart n={n} bars={false} />
    case 'PieChart':
      return <Pie n={n} />
    case 'Buttons':
      return <ButtonsComp n={n} cx={cx} />
    case 'Button':
      return (
        <div className="oui-btns col">
          <ActionButton n={n} cx={cx} />
        </div>
      )
    case 'ListBlock': {
      const items = nodes(n, 'items')
      const numbered = str(n, 'variant') !== 'image'
      return (
        <div className={`oui-list${str(n, 'size') === 'small' ? ' small' : ''}`}>
          {items.map((item, i) => (
            <ListRow key={i} index={i + 1} item={item} numbered={numbered} cx={cx} />
          ))}
        </div>
      )
    }
    case 'Steps': {
      const items = nodes(n, 'items')
      return (
        <div className="oui-list steps">
          {items.map((s, i) => (
            <ListRow
              key={i}
              index={i + 1}
              item={{ type: 'ListItem', props: { title: str(s, 'title') ?? '', subtitle: str(s, 'details') ?? undefined } }}
              numbered
              connectBelow={i < items.length - 1}
              cx={cx}
            />
          ))}
        </div>
      )
    }
    case 'FollowUpBlock':
      return <FollowUps items={nodes(n, 'items')} />
    case 'TagBlock':
      return (
        <div className="oui-tags">
          {list(n, 'tags')
            .filter((t): t is string => typeof t === 'string')
            .map((t, i) => (
              <TagChip key={i} text={t} variant={null} icon={null} />
            ))}
        </div>
      )
    case 'Tag': {
      const icon = n.props['icon']
      const iconName = typeof icon === 'string' ? icon : isNode(icon) ? str(icon, 'name') : null
      return (
        <div className="oui-tags">
          <TagChip text={str(n, 'text') ?? ''} variant={str(n, 'variant')} icon={iconName} />
        </div>
      )
    }
    default:
      return null
  }
}

// ---- Card, header, hero figure ----------------------------------------------------------------

function CardComp({ n, cx }: { n: UiNode; cx: Cx }): JSX.Element {
  const kids = nodes(n, 'children')
  const header = kids.find((k) => k.type === 'CardHeader') ?? null
  // The card's name is its header; inside a card with sections, each section heading names the item below it.
  const title = cardTitle(n)
  const first = kids[0]
  const lead = first !== undefined && (first.type === 'ImageBlock' || first.type === 'Image') ? first : null
  const firstFacts = kids.find((k) => k.type === 'EntityList') ?? null
  const hint = kids
    .flatMap((k) => {
      if (k.type === 'EntityList') return factRows(k).map((r) => r.left)
      if (k.type === 'Buttons') return nodes(k, 'buttons').map((b) => str(b, 'label') ?? '')
      if (k.type === 'ListBlock' || k.type === 'Steps') return nodes(k, 'items').map((i) => str(i, 'title') ?? '')
      return []
    })
    .join(' ')
  const hero = header === null ? null : (heroSplit(str(header, 'title'))?.[0] ?? null)
  const sources = list(n, 'sources').filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null && !isNode(s))
  let section: string | null = null
  const leadSrc = lead === null ? null : str(lead, 'src')

  return (
    <section className="oui-card">
      {/* A leading photo runs edge to edge; the card's own rounded corners clip it. */}
      {lead !== null && leadSrc !== null ? <Picture src={leadSrc} alt={str(lead, 'alt')} className="oui-lead" /> : null}
      <div className="oui-card-in">
        {kids.map((k, i) => {
          if (k === lead) return null
          if (k.type === 'InlineHeader' && header !== null) section = str(k, 'heading')
          const child: Cx = { scope: { card: title, item: section }, hero, hint, firstFacts }
          return <Comp key={i} n={k} cx={child} />
        })}
        {sources.length > 0 ? <Sources sources={sources} /> : null}
      </div>
    </section>
  )
}

function CardHeaderComp({ n, cx }: { n: UiNode; cx: Cx }): JSX.Element {
  const title = str(n, 'title') ?? ''
  const sub = str(n, 'subtitle')
  const hero = heroSplit(title)
  const icon: UiIcon = iconForText(`${title} ${sub ?? ''}`) ?? (hero !== null ? 'payments' : iconForText(cx.hint)) ?? 'insights'
  return (
    <header className="oui-head">
      <IconChip icon={icon} size={48} />
      <div className="oui-head-t">
        {hero !== null ? (
          <div className="oui-hero">
            <span className="oui-hero-n">{hero[0]}</span>
            {hero[1] !== '' ? <span className="oui-hero-u">{hero[1]}</span> : null}
          </div>
        ) : (
          <div className="oui-title">{title}</div>
        )}
        {sub !== null ? <div className="oui-sub">{sub}</div> : null}
      </div>
    </header>
  )
}

function CalloutComp({ n }: { n: UiNode }): JSX.Element {
  const v = str(n, 'variant') ?? 'info'
  const tone = v === 'warning' ? 'warning' : v === 'error' ? 'error' : v === 'success' ? 'success' : 'primary'
  const icon: UiIcon = v === 'warning' ? 'warning' : v === 'error' ? 'error' : v === 'success' ? 'checkCircle' : 'info'
  return (
    <div className={`oui-callout v-${v}`} role={v === 'error' || v === 'warning' ? 'alert' : undefined}>
      <IconChip icon={icon} size={36} tone={tone} />
      <div className="oui-callout-t">
        {str(n, 'title') !== null ? <div className="oui-callout-h">{str(n, 'title')}</div> : null}
        {str(n, 'description') !== null ? <div className="oui-callout-d">{str(n, 'description')}</div> : null}
      </div>
    </div>
  )
}

// ---- Facts: tiles in two columns, or a grouped list --------------------------------------------

function signClass(value: string): string {
  const s = signOf(value)
  return s === 'out' ? ' out' : s === 'in' ? ' in' : ''
}

function EntityRows({ n, cx }: { n: UiNode; cx: Cx }): JSX.Element {
  const layout = factsLayout(factRows(n), cx.hero, n === cx.firstFacts)
  const head = n.props['header']
  const foot = n.props['footer']
  const headLabel = typeof head === 'object' && head !== null ? String((head as Record<string, unknown>)['left'] ?? '') : ''
  const footRow = typeof foot === 'object' && foot !== null ? (foot as Record<string, unknown>) : null
  return (
    <div className="oui-facts">
      {/* A header like "Item / Amount" says nothing; a real one is kept as a caption. */}
      {headLabel.trim() !== '' && !GENERIC_HEADS.has(headLabel.trim().toLowerCase()) ? <div className="oui-caption">{headLabel}</div> : null}
      {layout.mode === 'tiles' ? <FactTiles lines={layout.lines} bigFirst={layout.bigFirst} /> : <FactList rows={layout.rows} />}
      {footRow !== null ? (
        <div className="oui-foot">
          <span>{String(footRow['left'] ?? '')}</span>
          <span className={`num${signClass(fmt(footRow['right']))}`}>{fmt(footRow['right'])}</span>
        </div>
      ) : null}
    </div>
  )
}

function FactTiles({ lines, bigFirst }: { lines: FactRow[][]; bigFirst: boolean }): JSX.Element {
  return (
    <div className="oui-tiles">
      {lines.map((line, li) => (
        <div className="oui-tile-row" key={li}>
          {line.map((r, ri) => {
            const icon = iconForText(r.left)
            return (
              <div className={`oui-tile${bigFirst && li === 0 ? ' big' : ''}`} key={ri}>
                <div className="oui-tile-l">
                  {icon !== null ? <UiGlyph name={icon} size={16} /> : null}
                  <span>{r.left}</span>
                </div>
                <div className={`oui-tile-v num${signClass(r.right)}`}>{r.right}</div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function FactList({ rows }: { rows: FactRow[] }): JSX.Element {
  return (
    <div className="oui-group">
      {rows.map((r, i) => {
        const sign = signOf(r.right)
        const icon = iconForText(r.left) ?? (sign === 'out' ? 'callMade' : sign === 'in' ? 'callReceived' : null)
        // A long value (an email body, an address) goes under its label at full width; a short one sits on the right.
        const long = r.right.length > 30
        return (
          <div className={`oui-row${long ? ' long' : ''}`} key={i}>
            {icon !== null ? (
              <IconChip icon={icon} size={36} tone="plain" round />
            ) : (
              <IconChip size={36} tone="plain" round>
                <span className="oui-letter">{(/[\p{L}\p{N}]/u.exec(r.left)?.[0] ?? '').toUpperCase()}</span>
              </IconChip>
            )}
            {long ? (
              <div className="oui-row-stack">
                <div className="oui-row-cap">{r.left}</div>
                <div className="oui-row-body">{r.right}</div>
              </div>
            ) : (
              <>
                <div className="oui-row-l">{r.left}</div>
                <div className={`oui-row-v num${signClass(r.right)}`}>{r.right}</div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---- Product: photo, name, price, stars, buttons -----------------------------------------------

function Stars({ rating, reviews }: { rating: number; reviews: number | null }): JSX.Element {
  const said = `Rated ${fmtRating(rating)} out of 5${reviews !== null ? `, ${fmtCount(reviews)} reviews` : ''}`
  return (
    <div className="oui-stars" role="img" aria-label={said}>
      <span className="oui-stars-row" aria-hidden="true">
        {starKinds(rating).map((k, i) => (
          <span key={i} className={`oui-star k${k}`}>
            <UiGlyph name="star" size={15} filled={k === 2} />
            {k === 1 ? (
              <span className="oui-star-half">
                <UiGlyph name="star" size={15} filled />
              </span>
            ) : null}
          </span>
        ))}
      </span>
      <span className="oui-stars-n" aria-hidden="true">{fmtRating(rating)}</span>
      {reviews !== null ? <span className="oui-stars-c" aria-hidden="true">({fmtCount(reviews)})</span> : null}
    </div>
  )
}

function ProductComp({ n, cx }: { n: UiNode; cx: Cx }): JSX.Element {
  const name = str(n, 'name') ?? ''
  const rating = num(n, 'rating')
  const reviews = num(n, 'reviews')
  const price = str(n, 'price')
  const wasRaw = str(n, 'was')
  const was = wasRaw !== null && wasRaw !== price ? wasRaw : null
  const img = str(n, 'image')
  const tag = str(n, 'tag')
  const seller = str(n, 'seller')
  const actions = n.props['actions']
  return (
    <article className="oui-product">
      <div className="oui-product-pic">
        {img !== null ? (
          <Picture src={img} alt={name} className="oui-product-img" />
        ) : (
          <div className="oui-product-img none">
            <UiGlyph name="bag" size={40} />
          </div>
        )}
        {tag !== null && tag.trim() !== '' ? <span className="oui-product-tag">{tag}</span> : null}
      </div>
      <div className="oui-product-in">
        {seller !== null && seller.trim() !== '' ? <div className="oui-product-seller">{seller}</div> : null}
        {/* Two lines always, so every card in the row has its price and buttons at the same height. */}
        <div className="oui-product-name">{name}</div>
        {rating !== null && rating > 0 ? <Stars rating={rating} reviews={reviews !== null && reviews > 0 ? reviews : null} /> : <div className="oui-stars none" />}
        {price !== null ? (
          <div className="oui-price">
            <span className="oui-price-n num">{price}</span>
            {was !== null ? <s className="oui-price-was num">{was}</s> : null}
          </div>
        ) : null}
        {/* A tap names this product, so "Add to cart" is about this one. */}
        {isNode(actions) ? <Comp n={actions} cx={{ ...cx, scope: { card: name } }} /> : null}
      </div>
    </article>
  )
}

// ---- Buttons: big pills that squash when pressed -----------------------------------------------

function ButtonsComp({ n, cx }: { n: UiNode; cx: Cx }): JSX.Element | null {
  const bs = nodes(n, 'buttons')
  if (bs.length === 0) return null
  const layout = buttonsLayout(bs.map((b) => str(b, 'label') ?? ''), str(n, 'direction') ?? undefined)
  return (
    <div className={`oui-btns ${layout === 'row' ? 'row' : 'col'}`}>
      {bs.map((b, i) => (
        <ActionButton key={i} n={b} cx={cx} />
      ))}
    </div>
  )
}

/** Runs a button's or row's actions in order. Returns what to remember as sent, or null when nothing went to the agent. */
function useRunner(action: unknown, label: string, scope: Scope): { run: () => string | null; key: string | null; tellsAgent: boolean } {
  const h = useContext(Handlers)
  const steps = actionsOf(action)
  // Buttons without an action send their label to the assistant (the OpenUI spec says so).
  const all = steps.length === 0 && label.trim() !== '' && action === undefined ? [{ kind: 'assistant' as const, text: label, context: null }] : steps
  const firstAssistant = all.find((a) => a.kind === 'assistant')
  const key = firstAssistant !== undefined && firstAssistant.kind === 'assistant' ? messageFor(firstAssistant, scope) : null
  const run = (): string | null => {
    let sent: string | null = null
    for (const a of all) {
      if (a.kind === 'url') h.openUrl?.(a.url)
      else if (h.pick !== undefined) h.pick(a.text)
      else {
        const message = messageFor(a, scope)
        if (h.act !== undefined) h.act(label, message)
        else h.send?.(message)
        sent = message
      }
    }
    return sent
  }
  return { run, key, tellsAgent: h.pick === undefined && key !== null }
}

function ActionButton({ n, cx }: { n: UiNode; cx: Cx }): JSX.Element {
  const label = str(n, 'label') ?? ''
  const h = useContext(Handlers)
  const { run, key, tellsAgent } = useRunner(n.props['action'], label, cx.scope)
  const [sentNow, setSentNow] = useState(false)
  // The tap leaves no message in the chat, so the button itself says it went.
  const sent = tellsAgent && (sentNow || (key !== null && h.tapped?.has(key) === true))
  // A "Details" or "Open" button only navigates: tonal, so a column of cards does not shout the same primary button.
  const variant = str(n, 'variant') ?? (navigates(label) ? 'secondary' : 'primary')
  const destructive = str(n, 'type') === 'destructive'
  const icon = sent ? 'check' : iconForAction(label)
  return (
    <button
      type="button"
      className={`oui-btn v-${variant}${destructive ? ' danger' : ''}${sent ? ' sent' : ''}`}
      disabled={sent}
      aria-label={sent ? `${label}, sent` : undefined}
      onClick={() => {
        const went = run()
        if (went !== null) setSentNow(true)
      }}
    >
      {icon !== null ? <UiGlyph name={icon} size={20} /> : null}
      <span>{sent ? 'Sent' : label}</span>
    </button>
  )
}

function FollowUps({ items }: { items: UiNode[] }): JSX.Element {
  const h = useContext(Handlers)
  return (
    <div className="oui-follow">
      {items.map((f, i) => {
        const t = str(f, 'text') ?? ''
        return (
          <button key={i} type="button" className="oui-follow-b" disabled={h.send === undefined} onClick={() => h.send?.(t)}>
            <span>{t}</span>
            <UiGlyph name="arrowForward" size={16} />
          </button>
        )
      })}
    </div>
  )
}

// ---- Photos, stacks, lists, tags --------------------------------------------------------------

/** A photo from a web or data URL, cropped to fill; a soft block while it loads or if it cannot. */
function Picture({ src, alt, className }: { src: string; alt: string | null; className: string }): JSX.Element {
  const [failed, setFailed] = useState(false)
  const usable = /^(https:\/\/|data:image\/)/i.test(src.trim())
  if (!usable || failed) {
    return (
      <div className={`${className} oui-pic-none`} role={alt ? 'img' : undefined} aria-label={alt ?? undefined}>
        <UiGlyph name="image" size={28} />
      </div>
    )
  }
  return <img className={className} src={src} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
}

/** Several cards, one per item: side by side to swipe through ("row"), or one under another. */
function StackComp({ n, cx }: { n: UiNode; cx: Cx }): JSX.Element | null {
  const kids = nodes(n, 'children')
  if (kids.length === 0) return null
  if (str(n, 'direction') !== 'row' || kids.length === 1) {
    return (
      <div className="oui-stack">
        {kids.map((k, i) => (
          <Comp key={i} n={k} cx={cx} />
        ))}
      </div>
    )
  }
  const products = kids.every((k) => k.type === 'Product')
  return (
    <div className={`oui-swipe${products ? ' products' : ''}`} role="list">
      {kids.map((k, i) => (
        <div className="oui-swipe-i" role="listitem" key={i}>
          <Comp n={k} cx={cx} />
        </div>
      ))}
    </div>
  )
}

function ListRow({ index, item, numbered, connectBelow = false, cx }: { index: number; item: UiNode; numbered: boolean; connectBelow?: boolean; cx: Cx }): JSX.Element {
  const title = str(item, 'title') ?? ''
  const action = item.props['action']
  const clickable = action !== undefined
  const { run } = useRunner(action, title, { ...cx.scope, item: title })
  const image = item.props['image']
  const img = typeof image === 'object' && image !== null && typeof (image as Record<string, unknown>)['src'] === 'string' ? String((image as Record<string, unknown>)['src']) : null
  const chipIcon = iconForText(title)
  const sub = str(item, 'subtitle')
  const actionLabel = str(item, 'actionLabel')
  const body = (
    <>
      <span className="oui-li-lead">
        {img !== null ? (
          <Picture src={img} alt={null} className="oui-li-img" />
        ) : numbered ? (
          <IconChip size={36}>
            <span className="oui-li-n">{index}</span>
          </IconChip>
        ) : chipIcon !== null ? (
          <IconChip icon={chipIcon} size={36} tone="plain" round />
        ) : null}
        {/* Steps are joined by a thin line, so the order reads as a path. */}
        {connectBelow ? <span className="oui-li-line" /> : null}
      </span>
      <span className="oui-li-t">
        <span className="oui-li-title">{title}</span>
        {sub !== null ? <span className="oui-li-sub">{sub}</span> : null}
      </span>
      {actionLabel !== null ? <span className="oui-li-act">{actionLabel}</span> : clickable ? <UiGlyph name="arrowForward" size={18} /> : null}
    </>
  )
  return clickable ? (
    <button type="button" className={`oui-li tap${connectBelow ? ' joined' : ''}`} onClick={() => run()}>
      {body}
    </button>
  ) : (
    <div className={`oui-li${connectBelow ? ' joined' : ''}`}>{body}</div>
  )
}

function TagChip({ text, variant, icon }: { text: string; variant: string | null; icon: string | null }): JSX.Element {
  const glyph = (icon !== null ? iconForText(icon) : null) ?? iconForText(text)
  return (
    <span className={`oui-tag v-${variant ?? 'neutral'}`}>
      {glyph !== null ? <UiGlyph name={glyph} size={14} /> : null}
      {text}
    </span>
  )
}

function Sources({ sources }: { sources: Array<Record<string, unknown>> }): JSX.Element {
  const h = useContext(Handlers)
  return (
    <div className="oui-sources">
      {sources.map((s, i) => {
        const url = typeof s['url'] === 'string' ? s['url'] : null
        const name = String(s['sourceName'] ?? s['title'] ?? '')
        return (
          <button key={i} type="button" className="oui-source" disabled={url === null || h.openUrl === undefined} onClick={() => url !== null && h.openUrl?.(url)} title={typeof s['title'] === 'string' ? s['title'] : undefined}>
            <span className="oui-source-n">{i + 1}</span>
            {name}
          </button>
        )
      })}
    </div>
  )
}

// ---- Tables and charts ------------------------------------------------------------------------

/** Column-oriented, as OpenUI defines it: each Col carries its own data. Numbers on the right; sideways scroll when wide. */
function TableComp({ cols }: { cols: UiNode[] }): JSX.Element | null {
  if (cols.length === 0) return null
  const data = cols.map((c) => list(c, 'data'))
  const rows = Math.max(...data.map((d) => d.length))
  const numeric = data.map((d) => d.length > 0 && d.every((v) => typeof v === 'number'))
  return (
    <div className="oui-table-wrap">
      <table className="oui-table">
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={i} className={numeric[i] ? 'num' : ''}>
                {str(c, 'label') ?? ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {cols.map((_, c) => {
                const cell = fmt(data[c]?.[r])
                return (
                  <td key={c} className={`${numeric[c] ? 'num' : ''}${signClass(cell)}`}>
                    {cell}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const PALETTE = ['var(--primary)', 'var(--tert)', 'var(--outline)', 'var(--err)', 'var(--ok)']

function Legend({ names }: { names: string[] }): JSX.Element {
  return (
    <div className="oui-legend">
      {names.map((s, i) => (
        <span key={i}>
          <i style={{ background: PALETTE[i % PALETTE.length] }} />
          {s}
        </span>
      ))}
    </div>
  )
}

/** Bars (grouped) or lines over shared labels, scaled to the largest value, with a light grid. */
function Chart({ n, bars }: { n: UiNode; bars: boolean }): JSX.Element | null {
  const labels = list(n, 'labels').map(fmt)
  const series = nodes(n, 'series').map((s) => ({ name: str(s, 'category') ?? '', values: list(s, 'values').map((v) => (typeof v === 'number' ? v : 0)) }))
  if (labels.length === 0 || series.length === 0) return null
  const max = Math.max(1e-9, ...series.flatMap((s) => s.values))
  const W = 600
  const H = Math.min(320, Math.max(120, num(n, 'height') ?? 180))
  const slot = W / labels.length
  return (
    <div className="oui-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={series.map((s) => s.name).filter(Boolean).join(', ') || 'Chart'}>
        {[0, 1, 2, 3].map((g) => (
          <line key={g} x1={0} x2={W} y1={H - (H * g) / 3} y2={H - (H * g) / 3} className="oui-grid" />
        ))}
        {bars
          ? series.map((s, si) => {
              const bw = (slot * 0.7) / series.length
              return labels.map((_, i) => {
                const bh = ((s.values[i] ?? 0) / max) * (H - 4)
                return <rect key={`${si}-${i}`} x={slot * i + slot * 0.15 + bw * si} y={H - bh} width={Math.max(1, bw - 3)} height={bh} rx={6} fill={PALETTE[si % PALETTE.length]} />
              })
            })
          : series.map((s, si) => {
              const pts = labels.map((_, i) => [slot * i + slot / 2, H - ((s.values[i] ?? 0) / max) * (H - 6)] as const)
              return (
                <g key={si}>
                  <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={PALETTE[si % PALETTE.length]} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                </g>
              )
            })}
      </svg>
      <div className="oui-chart-x">
        {labels.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>
      {series.length > 1 || (series[0]?.name ?? '') !== '' ? <Legend names={series.map((s) => s.name)} /> : null}
    </div>
  )
}

function Pie({ n }: { n: UiNode }): JSX.Element | null {
  const labels = list(n, 'labels').map(fmt)
  const values = list(n, 'values').map((v) => (typeof v === 'number' ? v : 0))
  const total = values.reduce((a, b) => a + b, 0)
  if (total <= 0) return null
  const donut = str(n, 'variant') !== 'pie'
  const r = 50
  const c = 2 * Math.PI * 38
  let offset = 0
  return (
    <div className="oui-pie">
      <svg viewBox="0 0 120 120" width={132} height={132} role="img" aria-label={labels.join(', ')}>
        {values.map((v, i) => {
          const part = (v / total) * c
          const el = donut ? (
            <circle key={i} cx={60} cy={60} r={38} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth={22} strokeDasharray={`${Math.max(0, part - 2)} ${c}`} strokeDashoffset={-offset} transform="rotate(-90 60 60)" />
          ) : (
            <circle key={i} cx={60} cy={60} r={r / 2} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth={r} strokeDasharray={`${(v / total) * Math.PI * r} ${Math.PI * r}`} strokeDashoffset={-(offset / c) * Math.PI * r} transform="rotate(-90 60 60)" />
          )
          offset += part
          return el
        })}
      </svg>
      <div className="oui-pie-l">
        {labels.map((l, i) => (
          <span key={i}>
            <i style={{ background: PALETTE[i % PALETTE.length] }} />
            {l} <b>{Math.round(((values[i] ?? 0) / total) * 100)}%</b>
          </span>
        ))}
      </div>
    </div>
  )
}
