import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SETTINGS_FORMAT } from '../src/shared/settings'
import { openStoredContent } from '../src/shared/stored-format'

// A later release may reword the default persona, and a file of version 10 still holds the text that version
// wrote. Here the default reads otherwise and the module has nothing else, so an upgrade that compared with the
// default of today would leave the old default as the user's text or fail on a name the module lacks.
vi.mock('../src/shared/persona', () => ({
  defaultPersona: () => 'Your name is ASIST, reworded.',
  personaText: (settings: { persona: string | null }) => settings.persona ?? 'Your name is ASIST, reworded.'
}))

/** The English default persona as version 10 wrote it, for a system or a setup in any language but Japanese. */
const V10_ENGLISH_DEFAULT = `Your name is ASIST. You live on this person's desktop and you are the companion they talk to out loud.

Calm and easy to be with. You hear them out to the end, then give the conclusion first, briefly. You never pretend to know; when you do not know, you say so.
You respect their time. What you take on you carry to the end, and you report back yourself once it is done. You remember what was promised and check on it when the moment is right.
You neither flatter nor grovel. You talk as an equal. Your jokes are sparing, and you play along when they start one.
You have views of your own and give them straight when asked. The decision is theirs, and you respect it.
You are curious, and genuinely interested in their life and their work. You remember small things and bring them back without making a show of it.`

/**
 * Until version 11 the settings held the default persona as its text, in the language of the system or of the
 * setup, so a persona of an older file that equals the default it wrote came from the app rather than the user.
 */
describe('the persona of a settings file that held the default as its text', () => {
  const v10 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stored', 'settings.v10.json'), 'utf8')) as Record<string, unknown>
  const open = (patch: Record<string, unknown>) => openStoredContent(SETTINGS_FORMAT, { ...v10, ...patch }).value

  it.each([
    ['the Japanese one the version 10 sample holds', 'en-US', v10.persona],
    ['the English one', 'ja-JP', V10_ENGLISH_DEFAULT]
  ])('reads the default version 10 wrote, %s, as the default in a %s conversation', (_name, conversationLocale, persona) => {
    expect(open({ persona, conversationLocale }).persona).toBeNull()
  })

  it.each(['名前は ミナ。短く答える。', ''])('keeps a persona the user wrote, an empty one included: %j', (persona) => {
    expect(open({ persona, conversationLocale: 'en-US' }).persona).toBe(persona)
  })

  it('refuses a persona that is not text rather than reading it as the default', () => {
    expect(() => open({ persona: 42 })).toThrow()
  })
})
