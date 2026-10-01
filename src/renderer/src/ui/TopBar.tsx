import { Mic, MicOff } from 'lucide-react'
import { Hud } from './Hud'
import { toggleMic } from '@/conversation'
import { isLiveEngine } from '@shared/voice-engine'
import { useT } from '@/i18n'
import { useLiveStore, useSettingsStore, useStatusStore, useTurnStore } from '@/state/stores'
import { useViewStore } from '@/state/view'
import asistIcon from '@/assets/holo/asist.png'

function StatusDot({ ok, label }: { ok: boolean; label: string }): React.JSX.Element {
  return (
    <span className={`status-dot${ok ? ' is-ok' : ''}`}>
      <i />
      {label}
    </span>
  )
}

export function TopBar(): React.JSX.Element {
  const t = useT()
  const status = useStatusStore((s) => s.status)
  const micState = useTurnStore((s) => s.micState)
  const micProgress = useTurnStore((s) => s.micProgress)
  const closeApp = useViewStore((s) => s.closeApp)
  const engine = useSettingsStore((s) => s.settings?.voiceEngine ?? 'cascade')
  const showHud = useSettingsStore((s) => s.settings?.showHud === true)
  const liveConnection = useLiveStore((s) => s.connection)

  return (
    <header className="topbar drag-region">
      <button className="brand" onClick={closeApp} aria-label={t('common.backToConversation')}>
        <img src={asistIcon} alt="" />
        <span>ASIST</span>
      </button>

      {/* The wrap stays when the bar is hidden, because it is what pushes the status dots and the microphone to the right. */}
      <div className="hud-wrap">{showHud && <Hud />}</div>

      {status && (
        <div className="status-dots">
          <StatusDot ok={status.llm} label="LLM" />
          {isLiveEngine(engine) ? (
            <StatusDot ok={liveConnection === 'open' || liveConnection === 'idle'} label="GEMINI" />
          ) : (
            <>
              <StatusDot ok={status.asr} label="ASR" />
              <StatusDot ok={status.tts} label="TTS" />
            </>
          )}
          <StatusDot ok={status.agent === 'found'} label="AGENT" />
        </div>
      )}

      <button
        onClick={() => void toggleMic()}
        className={`mic${micState === 'on' ? ' is-on' : micState === 'loading' ? ' is-loading holo-pulse' : ''}`}
        aria-label={micState === 'on' ? t('navigation.mic.turnOff') : t('navigation.mic.turnOn')}
      >
        {micState === 'on' ? <Mic size={13} /> : <MicOff size={13} />}
        {micState === 'on' ? 'LIVE' : micState === 'loading' ? `LOAD ${Math.round(micProgress)}%` : 'MIC OFF'}
      </button>
    </header>
  )
}
