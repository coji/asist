import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SETTINGS_FORMAT } from '../src/shared/settings'
import { openStoredContent } from '../src/shared/stored-format'

/**
 * Until version 10 the aizuchi switch silenced the bridge phrase as well, in every conversation language,
 * so the bridge phrase of an older file is what that switch made it.
 */
describe('the bridge phrase of a settings file written before it had a switch of its own', () => {
  const v9 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stored', 'settings.v9.json'), 'utf8')) as Record<string, unknown>
  const open = (patch: Record<string, unknown>) => openStoredContent(SETTINGS_FORMAT, { ...v9, ...patch }).value

  it.each(['ja-JP', 'en-US'] as const)('stays on where the aizuchi were on, in a %s conversation', (conversationLocale) => {
    const settings = open({ aizuchi: true, conversationLocale })
    expect(settings.bridgePhrase).toBe(true)
    expect(settings.aizuchi).toBe(true)
  })

  it.each(['ja-JP', 'en-US'] as const)('stays off where the aizuchi were off, in a %s conversation', (conversationLocale) => {
    const settings = open({ aizuchi: false, conversationLocale })
    expect(settings.bridgePhrase).toBe(false)
    expect(settings.aizuchi).toBe(false)
  })

  it('refuses an aizuchi value version 9 did not allow rather than guessing either switch', () => {
    expect(() => open({ aizuchi: 'yes' })).toThrow()
  })
})
