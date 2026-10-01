import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { LLM_PROVIDERS, LLM_PROVIDER_INFO, type LlmProvider } from '@shared/llm-catalog'
import { LIVE_ENGINE_INFO, isLiveEngine } from '@shared/voice-engine'
import type { MessageKey } from '@shared/i18n'
import { keyReadable, type ApiKeyState } from '@shared/ipc'
import { useStatusStore, useToastStore } from '@/state/stores'
import type { SettingsContext } from '../context'
import { Btn, Chip, Group, Page, type ChipTone } from '../primitives'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'

/** The API key of each provider, on a page of its own. */
export function ApiKeysPage({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const t = useT()
  return (
    <Page title={t('settings.pages.apiKeys')} lead={t('settingsIntegrations.apiKeys.description')}>
      <ApiKeys ctx={ctx} />
    </Page>
  )
}

const KEY_STATE_CHIP = {
  verified: { tone: 'ok', label: 'settingsIntegrations.apiKeys.verified' },
  saved: { tone: 'cyan', label: 'settingsIntegrations.apiKeys.saved' },
  unreadable: { tone: 'warn', label: 'settingsIntegrations.apiKeys.unreadable' },
  missing: { tone: 'dim', label: 'settingsIntegrations.apiKeys.notSet' }
} as const satisfies Record<ApiKeyState, { tone: ChipTone; label: MessageKey }>

/**
 * The API key of each provider. The list shows only the state, and the input field opens just for
 * registering a key. Before the key is saved it is checked against that provider's API, querying the
 * conversation model itself when it belongs to that provider.
 */
function ApiKeys({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const { settings, status } = ctx
  const t = useT()
  const [opened, setOpened] = useState<LlmProvider | null>(null)
  // The key of the provider behind a live engine is needed for that engine too, which the hint names.
  const liveEngine = isLiveEngine(settings.voiceEngine) ? LIVE_ENGINE_INFO[settings.voiceEngine] : null
  return (
    <Group>
      {LLM_PROVIDERS.map((provider) => {
        const info = LLM_PROVIDER_INFO[provider]
        const state = status?.llmKeys[provider] ?? 'missing'
        const saved = keyReadable(state)
        const inUse =
          provider === settings.conversationModel.provider ||
          provider === settings.bridgeModel.provider ||
          liveEngine?.provider === provider
        const engineOfProvider = Object.values(LIVE_ENGINE_INFO).find((engine) => engine.provider === provider)?.label ?? null
        return (
          <div key={provider} className="st-key" data-provider={provider}>
            <div className="st-key-name">
              <KeyRound size={14} style={{ color: 'var(--color-holo-dim)' }} />
              {info.label}
              <code>{info.envKey}</code>
              <Chip tone={KEY_STATE_CHIP[state].tone}>{t(KEY_STATE_CHIP[state].label)}</Chip>
              {inUse && <Chip tone="cyan">{t('settingsIntegrations.apiKeys.inUse')}</Chip>}
            </div>
            <Btn tone={saved ? 'quiet' : undefined} onClick={() => setOpened(opened === provider ? null : provider)}>
              {opened === provider
                ? t('common.close')
                : saved
                  ? t('settingsIntegrations.apiKeys.change')
                  : t('settingsIntegrations.apiKeys.register')}
            </Btn>
            <span className="st-key-hint">
              {engineOfProvider
                ? t('settingsIntegrations.apiKeys.hintWithLiveEngine', { engine: engineOfProvider })
                : t('settingsIntegrations.apiKeys.hint', { provider: info.label })}
            </span>
            {opened === provider && <KeyForm provider={provider} onDone={() => setOpened(null)} />}
          </div>
        )
      })}
    </Group>
  )
}

function KeyForm({ provider, onDone }: { provider: LlmProvider; onDone: () => void }): React.JSX.Element {
  const refreshStatus = useStatusStore((s) => s.refresh)
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const info = LLM_PROVIDER_INFO[provider]
  const submit = (): void => {
    setSaving(true)
    void window.api
      .saveApiKey(provider, key)
      .then(() => {
        toast({ kind: 'ok', title: t('settingsIntegrations.apiKeys.keySaved', { provider: info.label }) })
        onDone()
        return refreshStatus()
      })
      .catch((err: unknown) =>
        toast({ kind: 'error', title: t('settingsIntegrations.apiKeys.keySaveFailed', { provider: info.label }), body: displayError(err) })
      )
      .finally(() => setSaving(false))
  }
  return (
    <form
      className="st-key-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (key.trim() && !saving) submit()
      }}
    >
      <input
        type="password"
        autoComplete="off"
        autoFocus
        className="st-input is-mono"
        aria-label={info.envKey}
        placeholder={info.keyPlaceholder}
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      <Btn tone="primary" type="submit" disabled={saving || !key.trim()}>
        {saving ? t('settingsIntegrations.apiKeys.keyChecking') : t('settingsIntegrations.apiKeys.keySave')}
      </Btn>
      <Btn tone="quiet" onClick={() => void window.api.openExternal(info.console)}>
        {t('settingsIntegrations.apiKeys.openConsole')}
      </Btn>
    </form>
  )
}
