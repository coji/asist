import { useT } from '@/i18n'
import type { MessageKey } from '@shared/i18n'
import { LLM_PROVIDER_INFO } from '@shared/llm-catalog'
import { LIVE_ENGINE_INFO, type LiveEngine } from '@shared/voice-engine'
import { Chip } from '../settings/primitives'
import { ApiKeyField } from './api-key-field'

/** The two live engines in the order the setup offers them. The card already names the engine, so its note does not. */
const LIVE_ENGINES: Array<{ id: LiveEngine; hint: Extract<MessageKey, `setup.speaking.live.engines.${string}`> }> = [
  { id: 'gpt-live', hint: 'setup.speaking.live.engines.gptLive' },
  { id: 'gemini-live', hint: 'setup.speaking.live.engines.geminiLive' }
]

/**
 * The choice between the live engines inside the speaking step, and the key the chosen one runs on.
 * A key already verified, in the model step or before, is not asked for again.
 */
export function LiveEngineChoice({
  engine,
  onEngine,
  keyVerified,
  keyConfigured,
  apiKey,
  onApiKey,
  busy,
  onVerify,
  onRecheck
}: {
  engine: LiveEngine | null
  onEngine: (engine: LiveEngine) => void
  /** The key of the chosen engine's provider has been verified. */
  keyVerified: boolean
  keyConfigured: boolean
  apiKey: string
  onApiKey: (value: string) => void
  busy: boolean
  onVerify: () => void
  /** Verifies the key main already holds for the provider, saved earlier or set in the environment. */
  onRecheck: () => void
}): React.JSX.Element {
  const t = useT()
  const info = engine ? LIVE_ENGINE_INFO[engine] : null
  const provider = info ? LLM_PROVIDER_INFO[info.provider].label : ''
  return (
    <>
      <div className="su-providers" role="radiogroup" aria-label={t('setup.speaking.live.engineGroup')}>
        {LIVE_ENGINES.map(({ id, hint }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={engine === id}
            className="su-provider"
            data-engine={id}
            disabled={busy}
            onClick={() => onEngine(id)}
          >
            <span className="su-provider-name">{LIVE_ENGINE_INFO[id].label}</span>
            <span className="su-provider-note">{t(hint)}</span>
          </button>
        ))}
      </div>
      <p className="su-hint">{t('setup.speaking.live.note')}</p>
      {info &&
        (keyVerified ? (
          <div className="su-result" data-tone="ok">
            <Chip tone="ok">{t('setup.model.verified')}</Chip>
            <span>{t('setup.speaking.live.keyVerified', { engine: info.label, provider })}</span>
          </div>
        ) : (
          <>
            <p className="su-hint">{t('setup.speaking.live.keyNeeded', { engine: info.label, provider })}</p>
            <ApiKeyField provider={info.provider} keyConfigured={keyConfigured} apiKey={apiKey} onApiKey={onApiKey} busy={busy} onVerify={onVerify} onRecheck={onRecheck} />
          </>
        ))}
    </>
  )
}
