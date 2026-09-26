import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import { LLM_PROVIDERS, LLM_PROVIDER_INFO } from '@shared/llm-catalog'

/**
 * API keys saved on the settings screen: only the encrypted value reaches the file, the key never enters
 * process.env, nothing is stored where encryption is unavailable, and a key this build cannot decrypt
 * stops only its own provider until it is entered again.
 */

const reverse = (text: string): string => [...text].reverse().join('')
/** What a key encrypted by another build or another Keychain looks like to this process. */
const FOREIGN = 'encrypted-elsewhere:'
const electron = vi.hoisted(() => ({ userData: '', available: true, decryptFails: false }))
vi.mock('electron', () => ({
  app: { getPath: () => electron.userData },
  safeStorage: {
    isEncryptionAvailable: () => electron.available,
    encryptString: (plain: string) => Buffer.from(reverse(plain), 'utf8'),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString('utf8')
      if (electron.decryptFails || text.startsWith(FOREIGN)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return reverse(text)
    }
  }
}))

const models = vi.hoisted(() => ({
  settings: {
    uiLocale: 'ja-JP',
    conversationLocale: 'ja-JP',
    conversationModel: { provider: 'anthropic', id: 'claude-main' },
    bridgeModel: { provider: 'anthropic', id: 'claude-fast' }
  },
  retrieved: [] as Array<{ id: string; key: string }>
}))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => models.settings }))
vi.mock('../src/main/services/llm/call', () => {
  const adapter = {
    retrieveModel: async (id: string, key: string) => { models.retrieved.push({ id, key }) },
    listModels: async () => {}
  }
  return { ADAPTERS: { anthropic: adapter, openai: adapter, google: adapter, cerebras: adapter }, completeJson: vi.fn(), completeText: vi.fn() }
})

const KEY = 'sk-ant-api03-saved-in-settings'
const file = (): string => path.join(electron.userData, 'api-keys.json')

beforeEach(() => {
  vi.resetModules()
  electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-api-keys-'))
  electron.available = true
  electron.decryptFails = false
  models.settings.conversationModel = { provider: 'anthropic', id: 'claude-main' }
  models.settings.bridgeModel = { provider: 'anthropic', id: 'claude-fast' }
  models.retrieved.length = 0
  for (const provider of LLM_PROVIDERS) vi.stubEnv(LLM_PROVIDER_INFO[provider].envKey, undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(electron.userData, { recursive: true, force: true })
})

describe('saved API keys', () => {
  it('round-trips a key through an encrypted file and keeps it out of process.env', async () => {
    const keys = await import('../src/main/services/llm/keys')
    keys.saveProviderKey('anthropic', KEY)

    const raw = fs.readFileSync(file(), 'utf8')
    expect(raw).not.toContain(KEY)
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()

    vi.resetModules()
    const fresh = await import('../src/main/services/llm/keys')
    expect(fresh.providerKey('anthropic')).toBe(KEY)
    const { revealedApiKeys } = await import('../src/main/services/api-key-secrets')
    expect(revealedApiKeys()).toEqual([KEY])
  })

  // Windows has no POSIX permission bits; a file under the user's profile folder is guarded by that folder's access list.
  it.runIf(process.platform !== 'win32')('writes the file of saved keys readable by the owner alone', async () => {
    const keys = await import('../src/main/services/llm/keys')
    keys.saveProviderKey('anthropic', KEY)
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600)
  })

  it('uses a key from the environment over the saved one and refuses a save the environment would hide', async () => {
    const keys = await import('../src/main/services/llm/keys')
    keys.saveProviderKey('anthropic', KEY)
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-from-dotenv')
    expect(keys.providerKey('anthropic')).toBe('sk-ant-from-dotenv')
    expect(() => keys.saveProviderKey('anthropic', 'sk-ant-other')).toThrow(
      errorText('settingsIntegrations.apiKeys.errors.setInEnvironment', { envKey: 'ANTHROPIC_API_KEY' })
    )
    vi.stubEnv('ANTHROPIC_API_KEY', undefined)
    expect(keys.providerKey('anthropic')).toBe(KEY)
  })

  it('throws instead of storing a key where encryption is unavailable', async () => {
    electron.available = false
    const keys = await import('../src/main/services/llm/keys')
    expect(() => keys.saveProviderKey('openai', 'sk-proj-plain-text-key')).toThrow(
      errorText('settingsIntegrations.apiKeys.errors.encryptionUnavailable')
    )
    expect(fs.existsSync(file())).toBe(false)
    expect(keys.providerKey('openai')).toBeUndefined()
  })

  it('reports a key that this build cannot decrypt instead of treating it as absent', async () => {
    const keys = await import('../src/main/services/llm/keys')
    keys.saveProviderKey('google', 'AIza-saved-google-key')
    electron.decryptFails = true
    expect(() => keys.providerKey('google')).toThrow(errorText('settingsIntegrations.apiKeys.errors.keyUnreadable', { provider: 'Google' }))
  })
})

describe('a saved key that this build cannot decrypt', () => {
  /** The Anthropic key as the installed build saved it, seen from the development build or after the Keychain entry was lost. */
  const saveForeignAnthropicKey = (): void => {
    const secrets = { anthropic: Buffer.from(`${FOREIGN}sk-ant-old`, 'utf8').toString('base64') }
    fs.writeFileSync(file(), JSON.stringify({ version: 1, secrets }))
  }

  it('is replaced by entering it again, without the old key being read', async () => {
    saveForeignAnthropicKey()
    const llm = await import('../src/main/services/llm/configuration')
    await llm.validateProviderKey('anthropic', 'sk-ant-new')
    llm.saveProviderKey('anthropic', 'sk-ant-new')
    expect(models.retrieved).toEqual([{ id: 'claude-main', key: 'sk-ant-new' }, { id: 'claude-fast', key: 'sk-ant-new' }])
    expect(llm.providerKey('anthropic')).toBe('sk-ant-new')
    expect(llm.llmKeyStates().anthropic).toBe('verified')
  })

  it('is reported for its own provider while another key is saved and the status is read', async () => {
    saveForeignAnthropicKey()
    const llm = await import('../src/main/services/llm/configuration')
    await llm.validateProviderKey('openai', 'sk-openai-new')
    llm.saveProviderKey('openai', 'sk-openai-new')
    expect(llm.llmKeyStates()).toEqual({ anthropic: 'unreadable', openai: 'verified', google: 'missing', cerebras: 'missing' })
    await expect(llm.configuredApiKeyAvailable()).resolves.toBe(false)
    expect(() => llm.providerKey('anthropic')).toThrow(errorText('settingsIntegrations.apiKeys.errors.keyUnreadable', { provider: 'Anthropic' }))
  })

  it('does not stop a configuration whose models belong to another provider', async () => {
    saveForeignAnthropicKey()
    models.settings.conversationModel = { provider: 'openai', id: 'gpt-main' }
    models.settings.bridgeModel = { provider: 'openai', id: 'gpt-fast' }
    const llm = await import('../src/main/services/llm/configuration')
    llm.saveProviderKey('openai', 'sk-openai-saved')
    await expect(llm.configuredApiKeyAvailable()).resolves.toBe(true)
    expect(models.retrieved.map(({ id }) => id)).toEqual(['gpt-main', 'gpt-fast'])
  })
})
