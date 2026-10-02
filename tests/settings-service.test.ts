import { mkdtempSync, readFileSync } from 'node:fs'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultPersona, personaText } from '@shared/persona'

// The details of a zod failure vary by field, so the tests check which message the error carries.
const SETTINGS_INVALID = '[asist:settings.errors.invalid'
const SETTINGS_FILE_INVALID = '[asist:settings.errors.fileInvalid'
// An allowed folder written in full on either OS; on Windows /tmp/shared alone names a folder on the current drive.
const shared = path.resolve('/tmp/shared')

const mocks = vi.hoisted(() => ({
  userData: '',
  systemLanguages: ['ja-JP'],
  folders: {} as Record<string, string>
}))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => mocks.folders[name] ?? mocks.userData, getPreferredSystemLanguages: () => mocks.systemLanguages }
}))

// The first import of the settings service transforms its whole module graph, and the imports after vi.resetModules
// reuse that work. It took 358 ms alone but over 5000 ms while `npm run demo:fit` kept three headless
// Chromes busy (10-core Mac, 2026-09-24), which timed out whichever test came first. Importing once here moves
// that cost into a hook with a timeout of its own.
beforeAll(async () => {
  await import('../src/main/services/settings')
}, 30_000)

beforeEach(() => {
  vi.resetModules()
  mocks.systemLanguages = ['ja-JP']
  mocks.folders = {}
  mocks.userData = mkdtempSync(path.join(tmpdir(), 'asist-settings-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(mocks.userData, { recursive: true, force: true })
})

describe('settings persistence', () => {
  it('defaults a fresh install to the auto ASR model, which follows the installed memory', async () => {
    const settings = await import('../src/main/services/settings')

    expect(settings.getSettings().asrModel).toBe('auto')
  })

  it('starts a fresh install in the language of the system, for the interface, the conversation, the region and the persona', async () => {
    mocks.systemLanguages = ['de-AT', 'en-US']
    const settings = await import('../src/main/services/settings')

    expect(settings.getSettings()).toMatchObject({ uiLocale: 'de-DE', conversationLocale: 'de-DE', region: 'DE' })
    // A German conversation reads the English persona, the one every language but Japanese shares.
    expect(personaText(settings.getSettings())).toBe(defaultPersona('en-US'))
  })

  it('offers the folders where the system keeps the desktop, the downloads and the documents, wherever that is', async () => {
    mocks.folders = {
      desktop: 'C:\\Users\\someone\\OneDrive\\デスクトップ',
      downloads: 'C:\\Users\\someone\\Downloads',
      documents: 'C:\\Users\\someone\\OneDrive\\ドキュメント'
    }
    const settings = await import('../src/main/services/settings')

    expect([...settings.getSettings().fileRoots].sort()).toEqual(Object.values(mocks.folders).sort())
  })

  it('leaves every other setting as it is when one is saved', async () => {
    const settings = await import('../src/main/services/settings')
    settings.saveSettings({ uiLocale: 'de-DE', conversationLocale: 'en-US', region: 'US', qwenTtsVoice: 'ryan', fileRoots: [shared] })

    expect(settings.saveSettings({ hangoverMs: 700 })).toMatchObject({
      uiLocale: 'de-DE', conversationLocale: 'en-US', region: 'US', qwenTtsVoice: 'ryan', fileRoots: [shared], hangoverMs: 700
    })
  })

  it('leaves a setting as it is when a patch names it with the value undefined', async () => {
    const settings = await import('../src/main/services/settings')
    settings.saveSettings({ uiLocale: 'en-US', conversationLocale: 'en-US', region: 'US', qwenTtsVoice: 'ryan', fileRoots: [shared], bargeIn: true })
    settings.saveSettings({ mail: { notifyNewMail: false } })

    const saved = settings.saveSettings({
      uiLocale: undefined, conversationLocale: undefined, region: undefined, qwenTtsVoice: undefined, fileRoots: undefined,
      bargeIn: undefined, onboardingVersion: undefined, mail: { notifyNewMail: undefined }, hangoverMs: 700
    })
    expect(saved).toMatchObject({ uiLocale: 'en-US', conversationLocale: 'en-US', region: 'US', qwenTtsVoice: 'ryan', fileRoots: [shared], bargeIn: true, hangoverMs: 700 })
    expect(saved.mail.notifyNewMail).toBe(false)
  })

  it('changes one mail option onto the accounts main holds, and still checks the mail settings as a whole', async () => {
    const settings = await import('../src/main/services/settings')
    const account = {
      id: 'a1',
      label: '仕事',
      email: 'me@example.com',
      otherAddresses: [],
      name: '',
      provider: 'gmail' as const,
      imap: { host: 'imap.gmail.com', port: 993, secure: true },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
      folders: { sent: null, archive: null, trash: null }
    }
    // Main saves the whole mail group when it adds an account.
    settings.saveSettings({ mail: { ...settings.getSettings().mail, enabled: true, accounts: [account], defaultAccountId: 'a1' } })
    expect(settings.saveSettings({ mail: { notifyNewMail: false } }).mail).toMatchObject({ enabled: true, accounts: [account], defaultAccountId: 'a1', notifyNewMail: false })
    expect(() => settings.saveSettings({ mail: { defaultAccountId: 'gone' } })).toThrow(SETTINGS_INVALID)
    expect(settings.getSettings().mail.defaultAccountId).toBe('a1')
  })

  it.each(['{broken', JSON.stringify({ persona: 'incomplete' })])('does not overwrite a broken settings file with defaults and names the file and the reason: %s', async (source) => {
    const target = path.join(mocks.userData, 'settings.json')
    fs.writeFileSync(target, source)
    const settings = await import('../src/main/services/settings')
    expect(() => settings.getSettings()).toThrow(target)
    expect(() => settings.saveSettings({ persona: 'new' })).toThrow(SETTINGS_FILE_INVALID)
    expect(fs.readFileSync(target, 'utf8')).toBe(source)
  })

  it('does not treat a read permission failure as a fresh install', async () => {
    const settings = await import('../src/main/services/settings')
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })
    expect(() => settings.getSettings()).toThrow('permission denied')
  })

  it.each([
    { ttsEngine: 'unknown' }, { bargeIn: 'yes' }, { hangoverMs: -1 },
    { aizuchiRate: 1.1 }, { partialIntervalMs: 1501 }, { persona: 42 },
    { asrModel: 'nope' }, { conversationLogRetentionDays: 0 }, { voicevoxSpeaker: 1.5 },
    { dockOrder: ['jobs', 'tasks', 'memory', 'calendar'] }, { dockOrder: ['jobs', 'jobs', 'memory', 'calendar', 'settings'] }
  ])('rejects an invalid value with the same schema whether it arrives from a save or from the file: %j', async (patch) => {
    const settings = await import('../src/main/services/settings')
    const saved = settings.saveSettings({ persona: 'before' })
    const target = path.join(mocks.userData, 'settings.json')
    const original = fs.readFileSync(target, 'utf8')
    expect(() => settings.saveSettings(patch as never)).toThrow(SETTINGS_INVALID)
    expect(settings.getSettings()).toEqual(saved)
    expect(fs.readFileSync(target, 'utf8')).toBe(original)
    fs.writeFileSync(target, JSON.stringify({ ...saved, ...patch }))
    vi.resetModules()
    const reloaded = await import('../src/main/services/settings')
    expect(() => reloaded.getSettings()).toThrow(SETTINGS_INVALID)
  })

  it('saves no folder to read files under or to start jobs in that is not written in full, and still saves beside one an older file holds', async () => {
    const settings = await import('../src/main/services/settings')
    const saved = settings.saveSettings({ fileRoots: [mocks.userData] })
    expect(() => settings.saveSettings({ fileRoots: [mocks.userData, 'Documents'] })).toThrow('[asist:app.storage.folderNotFull')
    expect(() => settings.saveSettings({ agentCwd: 'work' })).toThrow('[asist:app.storage.folderNotFull')
    expect(settings.getSettings()).toEqual(saved)
    const target = path.join(mocks.userData, 'settings.json')
    fs.writeFileSync(target, JSON.stringify({ ...JSON.parse(fs.readFileSync(target, 'utf8')), fileRoots: ['Documents'] }))
    vi.resetModules()
    const reloaded = await import('../src/main/services/settings')
    expect(reloaded.saveSettings({ persona: 'after' })).toMatchObject({ persona: 'after', fileRoots: ['Documents'] })
  })

  it('trims the model name and accepts 0, which turns partial recognition off', async () => {
    const settings = await import('../src/main/services/settings')
    expect(settings.saveSettings({ conversationModel: { provider: 'openai', id: ' model ', effort: 'medium' }, partialIntervalMs: 0 })).toMatchObject({
      conversationModel: { provider: 'openai', id: 'model', effort: 'medium' }, partialIntervalMs: 0
    })
  })

  it('renames a temp file atomically and returns the settings it saved', async () => {
    const settings = await import('../src/main/services/settings')

    const saved = settings.saveSettings({ persona: 'saved' })

    expect(saved.persona).toBe('saved')
    expect(JSON.parse(readFileSync(path.join(mocks.userData, 'settings.json'), 'utf8'))).toMatchObject({
      persona: 'saved'
    })
  })

  it('leaves the in-process cache on the previous value when the rename fails', async () => {
    const settings = await import('../src/main/services/settings')
    settings.saveSettings({ persona: 'before' })
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('disk failure')
    })

    expect(() => settings.saveSettings({ persona: 'not-saved' })).toThrow('disk failure')
    expect(settings.getSettings().persona).toBe('before')
    rename.mockRestore()
  })
})
