import { describe, expect, it } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { readErrorText } from '@shared/i18n/error-text'
import { LIVE_TEXT_MAX_LENGTH, liveTextInput } from '@shared/voice-engine'

describe('the typed text a live engine takes', () => {
  it('takes text up to the limit, trimmed', () => {
    const longest = 'あ'.repeat(LIVE_TEXT_MAX_LENGTH)
    expect(liveTextInput(`  ${longest}\n`)).toBe(longest)
  })

  it('refuses text over the limit with a message the screen shows in its own language', () => {
    let message = ''
    try {
      liveTextInput('あ'.repeat(LIVE_TEXT_MAX_LENGTH + 1))
    } catch (error) {
      message = (error as Error).message
    }
    const t = createTranslator('ja-JP')
    expect(readErrorText(message, 'ja-JP')).toBe(t('voice.live.textTooLong', { max: LIVE_TEXT_MAX_LENGTH }))
  })
})
