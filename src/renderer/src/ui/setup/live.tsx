import { useT } from '@/i18n'
import { LLM_PROVIDER_INFO } from '@shared/llm-catalog'
import { LIVE_ENGINE_INFO } from '@shared/voice-engine'
import { Chip } from '../settings/primitives'
import { ApiKeyField } from './api-key-field'

/**
 * The key Gemini Live runs on, inside the speaking step. A key already verified, in the model step or
 * before, is not asked for again.
 */
export function LiveKey({
  keyVerified,
  keyConfigured,
  apiKey,
  onApiKey,
  busy,
  onVerify,
  onRecheck
}: {
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
  const info = LIVE_ENGINE_INFO['gemini-live']
  const provider = LLM_PROVIDER_INFO[info.provider].label
  return (
    <>
      <p className="su-hint">{t('setup.speaking.live.note')}</p>
      {keyVerified ? (
        <div className="su-result" data-tone="ok">
          <Chip tone="ok">{t('setup.model.verified')}</Chip>
          <span>{t('setup.speaking.live.keyVerified', { engine: info.label, provider })}</span>
        </div>
      ) : (
        <>
          <p className="su-hint">{t('setup.speaking.live.keyNeeded', { engine: info.label, provider })}</p>
          <ApiKeyField provider={info.provider} keyConfigured={keyConfigured} apiKey={apiKey} onApiKey={onApiKey} busy={busy} onVerify={onVerify} onRecheck={onRecheck} />
        </>
      )}
    </>
  )
}
