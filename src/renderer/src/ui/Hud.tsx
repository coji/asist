import type { TurnTimings } from '@shared/ipc'
import type { MessageKey } from '@shared/i18n'
import { isLiveEngine } from '@shared/voice-engine'
import { useT } from '@/i18n'
import { useLiveStore, useSettingsStore, useTurnStore } from '@/state/stores'
import { routerNoteText } from './router-note'

/**
 * The measured latencies of the latest turn, for VAD, ASR, aizuchi, bridge, TTFT, TTS and end to
 * end, together with the bar chart of the pipeline. A live engine does its listening and speaking
 * inside the model, so it shows the connection, the response, the session time and the cost instead.
 */

function LiveHud(): React.JSX.Element {
  const t = useT()
  const live = useLiveStore()
  const minutes = live.usage ? live.usage.sessionSeconds / 60 : null
  const metrics: Array<{ key: string; label: string; value: string | null; big?: boolean }> = [
    { key: 'connection', label: t('hud.live.title'), value: t(`hud.connection.${live.connection}`) },
    { key: 'connect', label: t('hud.live.connect'), value: live.connectMs !== null ? `${live.connectMs}ms` : null },
    { key: 'response', label: t('hud.live.response'), value: live.responseMs !== null ? `${live.responseMs}ms` : null, big: true },
    { key: 'session', label: t('hud.live.session'), value: minutes !== null ? t('hud.live.sessionMinutes', { minutes: minutes.toFixed(1) }) : null },
    { key: 'cost', label: t('hud.live.cost'), value: live.usage ? `$${live.usage.costUsd.toFixed(3)}` : null }
  ]
  return (
    <div className="hud">
      <div className="hud-metrics">
        {metrics.map((m) => (
          <div key={m.key} className="hud-metric">
            <span className="hud-label">{m.label}</span>
            <span className={`hud-value${m.value === null ? ' is-empty' : ''}${m.big ? ' is-big' : ''}`}>{m.value ?? '—'}</span>
          </div>
        ))}
        <RouterMetric />
      </div>
      <div className="hud-bar" aria-hidden />
    </div>
  )
}

/** What the latest turn's routing did. Before the first turn there is nothing to say, as for a latency not yet measured. */
function RouterMetric(): React.JSX.Element {
  const t = useT()
  const note = useTurnStore((s) => s.routerNote)
  const shownUtterance = useTurnStore((s) => s.shownUtterance)
  const routerNote = note ? routerNoteText(note, t, shownUtterance) : ''
  return (
    <div className="hud-metric is-router">
      <span className="hud-label">{t('hud.metrics.router')}</span>
      <span className={`hud-value is-router${routerNote ? '' : ' is-empty'}`} title={routerNote || undefined}>
        {routerNote || '—'}
      </span>
    </div>
  )
}

const METRICS = [
  { key: 'vadMs', label: 'hud.metrics.vad' },
  { key: 'asrMs', label: 'hud.metrics.asr' },
  { key: 'aizuchiMs', label: 'hud.metrics.aizuchi' },
  { key: 'bridgeMs', label: 'hud.metrics.bridge' },
  { key: 'ttftMs', label: 'hud.metrics.ttft' },
  { key: 'ttsMs', label: 'hud.metrics.tts' },
  { key: 'e2eMs', label: 'hud.metrics.e2e', big: true }
] as const satisfies ReadonlyArray<{
  key: 'vadMs' | 'asrMs' | 'aizuchiMs' | 'bridgeMs' | 'ttftMs' | 'ttsMs' | 'e2eMs'
  label: MessageKey
  big?: boolean
}>

/** Which path the dynamic hangover took. The fixed one is the ordinary case and is not shown. */
const VAD_MODE_LABEL = {
  early: 'hud.vadMode.early',
  extended: 'hud.vadMode.extended',
  fixed: null
} as const satisfies Record<NonNullable<TurnTimings['vadMode']>, MessageKey | null>

const STAGES = [
  { key: 'vadMs', label: 'hud.stages.endOfSpeech' },
  { key: 'asrMs', label: 'hud.metrics.asr' },
  { key: 'ttftMs', label: 'hud.stages.llm' },
  { key: 'ttsMs', label: 'hud.metrics.tts' }
] as const satisfies ReadonlyArray<{ key: 'vadMs' | 'asrMs' | 'ttftMs' | 'ttsMs'; label: MessageKey }>

export function Hud(): React.JSX.Element {
  const engine = useSettingsStore((s) => s.settings?.voiceEngine ?? 'cascade')
  if (isLiveEngine(engine)) return <LiveHud />
  return <CascadeHud />
}

function CascadeHud(): React.JSX.Element {
  const t = useT()
  const timings = useTurnStore((s) => s.timings)
  const total = STAGES.reduce((sum, s) => sum + (timings[s.key] ?? 0), 0)

  return (
    <div className="hud">
      <div className="hud-metrics">
        {METRICS.map((m) => {
          const value = timings[m.key]
          const mode = m.key === 'vadMs' && timings.vadMode ? VAD_MODE_LABEL[timings.vadMode] : null
          return (
            <div key={m.key} className="hud-metric">
              <span className="hud-label">{t(m.label)}</span>
              <span className={`hud-value${value == null ? ' is-empty' : ''}${'big' in m ? ' is-big' : ''}`}>
                {value != null ? `${value}ms` : '—'}
                {mode && <span className="hud-mode">{t(mode)}</span>}
              </span>
            </div>
          )
        })}
        <RouterMetric />
      </div>

      <div className="hud-bar">
        {STAGES.map((stage) => {
          const value = timings[stage.key] ?? 0
          return (
            <i
              key={stage.key}
              title={t('hud.stages.duration', { stage: t(stage.label), ms: value })}
              style={{ width: total > 0 ? `${(value / total) * 100}%` : 0 }}
            />
          )
        })}
      </div>
    </div>
  )
}
