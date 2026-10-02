import { safeStorage, shell } from 'electron'
import { errorText } from '@shared/i18n/error-text'
import type { ChatGptStatus } from '@shared/ipc'
import { ChatGptAuth, type ChatGptSecretId } from './chatgpt-oauth'
import { createEncryptedSecretStore } from './encrypted-secrets'
import { t } from './i18n'
import { signInPage } from './oauth-loopback'
import { dataPath } from './store'

/** The ChatGPT sign-in of this process, whose registration and tokens live encrypted in userData/chatgpt.json. */

let shared: ChatGptAuth | null = null

/** The page the browser shows when OpenAI sends it back to ASIST, in the language of the interface. */
const chatgptSignInPage = (signedIn: boolean): string =>
  signInPage(t(signedIn ? 'settingsIntegrations.chatgpt.browserDone' : 'settingsIntegrations.chatgpt.browserFailed'))

/** Created on first use so that the userData path is resolved only after app ready. */
export function chatgptAuth(): ChatGptAuth {
  return (shared ??= new ChatGptAuth({
    secrets: createEncryptedSecretStore<ChatGptSecretId>({
      filePath: dataPath('chatgpt.json'),
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (encrypted) => safeStorage.decryptString(encrypted),
      errors: {
        encryptionUnavailable: () => errorText('settingsIntegrations.chatgpt.errors.encryptionUnavailable'),
        secretUnreadable: () => errorText('settingsIntegrations.chatgpt.errors.unreadable'),
        fileUnreadable: (file, reason) => errorText('settingsIntegrations.chatgpt.errors.fileUnreadable', { file, reason }),
        fileBroken: (file) => errorText('settingsIntegrations.chatgpt.errors.fileBroken', { file })
      }
    }),
    fetch,
    openBrowser: (url) => shell.openExternal(url),
    page: chatgptSignInPage
  }))
}

export function chatgptStatus(): ChatGptStatus {
  const auth = chatgptAuth()
  const state = auth.signInState()
  return { state, email: state === 'signedIn' ? (auth.account()?.email ?? null) : null }
}
