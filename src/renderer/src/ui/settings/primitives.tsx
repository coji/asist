import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { useT } from '@/i18n'

/**
 * The parts the settings screen is built from, in three levels: a page with a title and one
 * sentence, a group drawn as a card, and a row with a name, a short hint and a control. Their
 * appearance lives in assets/settings.css.
 */

export function Page({ title, lead, children }: { title: string; lead: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="st-page">
      <header>
        <h2>{title}</h2>
        <p>{lead}</p>
      </header>
      {children}
    </div>
  )
}

export function Group({
  title,
  description,
  action,
  children
}: {
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="st-group" aria-label={title}>
      <header>
        <div>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
        {action}
      </header>
      <div className="st-group-body">{children}</div>
    </section>
  )
}

export function Row({
  label,
  hint,
  wide,
  disabled,
  children
}: {
  label: string
  hint?: ReactNode
  /** Spreads the control across the line below the row, which a long input field needs. */
  wide?: boolean
  disabled?: boolean
  children?: ReactNode
}): React.JSX.Element {
  return (
    <div className={`st-row${wide ? ' is-wide' : ''}${disabled ? ' is-disabled' : ''}`}>
      <div className="st-row-text">
        <span className="st-row-label">{label}</span>
        {hint && <span className="st-row-hint">{hint}</span>}
      </div>
      {children && <div className="st-row-control">{children}</div>}
    </div>
  )
}

/** The hint of a row whose field holds text that could not be saved, in place of its usual hint. */
export function NotSavedHint(): React.JSX.Element {
  const t = useT()
  return (
    <span className="st-row-hint-failed" role="alert">
      {t('settings.fieldNotSaved')}
    </span>
  )
}

export type ChipTone = 'ok' | 'warn' | 'cyan' | 'dim'

export function Chip({ tone = 'dim', children }: { tone?: ChipTone; children: ReactNode }): React.JSX.Element {
  return (
    <span className="st-chip" data-tone={tone}>
      {children}
    </span>
  )
}

export function Btn({
  tone,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'quiet' | 'danger' }): React.JSX.Element {
  return <button type="button" className="st-btn" data-tone={tone} {...rest} />
}

/** A small link that leads on to another settings page. */
export function Link({ onClick, children }: { onClick: () => void; children: ReactNode }): React.JSX.Element {
  return (
    <button type="button" className="st-link" onClick={onClick}>
      {children}
      <ChevronRight size={12} />
    </button>
  )
}

/** Folds away the items that are rarely touched. */
export function Advanced({ title, note, children }: { title: string; note?: string; children: ReactNode }): React.JSX.Element {
  return (
    <details className="st-advanced">
      <summary>
        <ChevronRight size={14} />
        {title}
        {note && <small>{note}</small>}
      </summary>
      {children}
    </details>
  )
}

export function Progress({ percent, label }: { percent: number; label?: string }): React.JSX.Element {
  return (
    <div className="st-progress-block">
      <div className="st-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
      </div>
      {label && <span className="st-progress-label">{label}</span>}
    </div>
  )
}
