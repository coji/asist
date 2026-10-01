import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SETTINGS_FORMAT } from '../src/shared/settings'
import { openStoredContent } from '../src/shared/stored-format'

describe('the voice engine of a settings file written before GPT-Live was dropped', () => {
  const v8 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stored', 'settings.v8.json'), 'utf8')) as Record<string, unknown>
  const open = (voiceEngine: string) => openStoredContent(SETTINGS_FORMAT, { ...v8, voiceEngine }).value

  it('talks through cascade where GPT-Live was chosen', () => {
    expect(open('gpt-live').voiceEngine).toBe('cascade')
  })

  it('keeps Gemini Live and its model and voice where they were chosen', () => {
    const settings = open('gemini-live')
    expect(settings.voiceEngine).toBe('gemini-live')
    expect(settings.geminiLive).toEqual(v8.geminiLive)
  })
})
