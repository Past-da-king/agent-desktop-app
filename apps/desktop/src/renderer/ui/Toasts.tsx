import { useToast } from '../state/useToast'
import { Icon } from './Icon'

export function Toasts(): JSX.Element | null {
  const toasts = useToast((state) => state.toasts)
  const dismiss = useToast((state) => state.dismiss)

  if (toasts.length === 0) return null

  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((item) => (
        <div className="toast" key={item.id} role="status">
          <span>{item.message}</span>
          {item.actionLabel ? (
            <button
              type="button"
              className="btn text sm"
              onClick={() => {
                item.onAction?.()
                dismiss(item.id)
              }}
            >
              {item.actionLabel}
            </button>
          ) : null}
          <button type="button" className="ib" aria-label="Dismiss" onClick={() => dismiss(item.id)}>
            <Icon name="x" size={18} />
          </button>
        </div>
      ))}
    </div>
  )
}
