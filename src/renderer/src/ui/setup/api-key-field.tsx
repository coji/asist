import { ExternalLink } from 'lucide-react'
import { useT } from '@/i18n'
import { LLM_PROVIDER_INFO, type LlmProvider } from '@shared/llm-catalog'
import { Btn } from '../settings/primitives'

/**
 * The field that takes one provider's API key and has it verified before it is saved. The model step
 * asks for the key of the conversation model, and the speaking step for the key a live engine runs on.
 */
export function ApiKeyField({
  provider,
  keyConfigured,
  apiKey,
  onApiKey,
  busy,
  onVerify,
  onRecheck
}: {
  provider: LlmProvider
  /** The key is stored but has not been confirmed yet, for instance because the request failed. */
  keyConfigured: boolean
  apiKey: string
  onApiKey: (value: string) => void
  busy: boolean
  onVerify: () => void
  /** Offered only where a stored key can be verified again without being typed. */
  onRecheck?: () => void
}): React.JSX.Element {
  const t = useT()
  const info = LLM_PROVIDER_INFO[provider]
  return (
    <div className="su-field">
      <label htmlFor="su-key">
        {t('setup.model.apiKey', { provider: info.label })}
        <button type="button" className="su-link" onClick={() => void window.api.openExternal(info.console)}>
          {t('setup.model.createKey')}
          <ExternalLink size={12} aria-hidden />
        </button>
      </label>
      {keyConfigured && <p className="su-warn">{t('setup.model.savedKeyFailed')}</p>}
      <div className="su-inline">
        <input
          id="su-key"
          type="password"
          autoComplete="off"
          className="st-input is-mono"
          value={apiKey}
          placeholder={info.keyPlaceholder}
          onChange={(event) => onApiKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onVerify()
          }}
        />
        <Btn tone="primary" disabled={busy || !apiKey.trim()} onClick={onVerify}>
          {busy ? t('setup.model.verifying') : t('setup.model.verifyAndSave')}
        </Btn>
      </div>
      <p className="su-hint">
        {info.consoleNote && <>{t('setup.model.keyIssueNote', { note: t(info.consoleNote) })} </>}
        {t('setup.model.keyStoredNote', { provider: info.label })}
        {keyConfigured && onRecheck && (
          <button type="button" className="su-link" disabled={busy} onClick={onRecheck}>
            {t('setup.model.verifySavedKey')}
          </button>
        )}
      </p>
    </div>
  )
}
