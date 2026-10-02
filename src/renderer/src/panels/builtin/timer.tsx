import { useEffect, useState } from 'react'
import type { AppTimer } from '@shared/ipc'
import { translate, useT } from '@/i18n'
import { usePanelStore } from '@/state/stores'
import type { CardContext, CardDefinition } from '../shell/card'
import { Action, Actions, Box, Facts } from '../primitives/Card'
import { clockTime, durationLabel } from '../primitives/format'
import './timer.css'
import { displayError } from '@/display-error'

/** Timer card. The remaining time is counted against the timer registered in main. */

const RING_RADIUS = 42
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

/** Renders "02:58", or "1:02:58" once an hour or more is left. */
export const remainingText = (seconds: number): string => {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return h ? `${h}:${mmss}` : mmss
}

function Ring({ percent, done }: { percent: number; done: boolean }): React.JSX.Element {
  return (
    <svg className="tm-ring" viewBox="0 0 100 100" aria-hidden data-done={done || undefined}>
      <circle className="tm-ring-track" cx="50" cy="50" r={RING_RADIUS} />
      <circle
        className="tm-ring-fill"
        cx="50"
        cy="50"
        r={RING_RADIUS}
        strokeDasharray={RING_LENGTH}
        strokeDashoffset={RING_LENGTH * (1 - percent / 100)}
      />
    </svg>
  )
}

/**
 * The timer main keeps under the card's key, as main last reported it. Its times are the only ones the card shows:
 * the panel itself is made again whenever the timer is restored, after a restart for one, so the panel's own
 * times say nothing about the timer. Until main answers there is neither a timer nor an error.
 */
function useTimer(key: string): { timer?: AppTimer; error?: string } {
  const [state, setState] = useState<{ timer?: AppTimer; error?: string }>({})
  useEffect(() => {
    let mounted = true
    const unsubscribe = window.api.onTimerEvent((event) => {
      if (event.type === 'updated' && event.timer.id === key) setState({ timer: event.timer })
      if (event.type === 'removed' && event.id === key) setState({ error: translate('cardsTime.timer.notRunning') })
    })
    void window.api
      .timerList()
      .then((timers) => {
        if (!mounted) return
        const existing = timers.find((candidate) => candidate.id === key)
        setState(existing ? { timer: existing } : { error: translate('cardsTime.timer.notRunning') })
      })
      .catch((err: unknown) => {
        if (mounted) setState({ error: displayError(err) })
      })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [key])
  return state
}

function EndsAt({ spec }: CardContext): React.JSX.Element | null {
  const t = useT()
  const { timer } = useTimer(spec.key)
  return timer ? <span className="tm-ends">{t('cardsTime.timer.endsAt', { time: clockTime(timer.endsAt) })}</span> : null
}

function TimerBody({ spec, size }: CardContext): React.JSX.Element {
  const t = useT()
  const { timer, error } = useTimer(spec.key)
  const [now, setNow] = useState(Date.now)
  const [cancelError, setCancelError] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const dismiss = usePanelStore((s) => s.dismiss)

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(tick)
  }, [])

  // Stopping the timer, and closing the card once the time is up, both delete the timer in main before the
  // card itself closes.
  const cancel = (): void => {
    if (cancelling) return
    setCancelling(true)
    void window.api
      .timerCancel(spec.key)
      .then(() => dismiss(spec.key))
      .catch((err: unknown) => setCancelError(displayError(err)))
      .finally(() => setCancelling(false))
  }

  if (!timer) {
    return (
      <div className="card tm" data-size={size}>
        <p className="card-missing" role={error ? 'alert' : 'status'}>
          {error ?? t('common.loading')}
        </p>
      </div>
    )
  }
  const remain = Math.max(0, timer.endsAt - now)
  const remainingSeconds = Math.ceil(remain / 1000)
  const percent = timer.seconds > 0 ? Math.min(100, (remain / (timer.seconds * 1000)) * 100) : 0
  const done = timer.status === 'finished' || remain <= 0
  return (
    <div className="card tm" data-size={size} data-done={done || undefined}>
      <div className="tm-top">
        <div className="card-hero">
          <h3>{timer.label}</h3>
          <p>{t('cardsTime.timer.duration', { duration: durationLabel(timer.seconds) })}</p>
          <div className="card-big">
            <strong>
              <time aria-live={done ? 'assertive' : undefined}>
                {done ? t('cardsTime.timer.done') : remainingText(remainingSeconds)}
              </time>
            </strong>
          </div>
          <p className="card-note">
            {done
              ? t('cardsTime.timer.endedAt', { time: clockTime(timer.endsAt) })
              : t('cardsTime.timer.endsAt', { time: clockTime(timer.endsAt) })}
          </p>
        </div>
        {size !== 's' && <Ring percent={percent} done={done} />}
      </div>
      <div
        className="tm-bar"
        role="progressbar"
        aria-label={t('cardsTime.timer.remaining')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <i style={{ width: `${percent}%` }} />
      </div>
      {(size === 'l' || size === 'focus') && (
        <Box title={t('cardsTime.timer.times')}>
          <Facts
            items={[
              [t('cardsTime.timer.start'), clockTime(timer.createdAt)],
              [t('cardsTime.timer.end'), clockTime(timer.endsAt)]
            ]}
          />
        </Box>
      )}
      {cancelError && (
        <p className="card-missing" role="alert">
          {cancelError}
        </p>
      )}
      <Actions>
        {done ? (
          <Action tone="warm" onClick={cancel} disabled={cancelling}>
            {t('common.close')}
          </Action>
        ) : (
          <Action tone="danger" onClick={cancel} disabled={cancelling}>
            {cancelling ? t('cardsTime.timer.stopping') : t('cardsTime.timer.stop')}
          </Action>
        )}
      </Actions>
    </div>
  )
}

export const timerCard: CardDefinition = {
  Body: TimerBody,
  kicker: 'TIMER',
  className: 'tm-card',
  meta: EndsAt
}
