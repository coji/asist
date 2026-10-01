import { describe, expect, it } from 'vitest'
import { formatLocaleOf, CONVERSATION_LOCALES, REGIONS, conversationFeatures, defaultRegion, defaultTtsEngine, fillPrompt, pickInitialLocale, promptText, speechTag, ttsEngineSpeaks } from '@shared/conversation-locale'
import { deriveCapabilities } from '@shared/platform'
import { MACOS, WINDOWS, WINDOWS_WITHOUT_GPU } from './helpers/platform'

describe('pickInitialLocale', () => {
  it('takes the first preferred language that the app speaks, whatever its region', () => {
    expect(pickInitialLocale(['ja-JP', 'en-US'])).toBe('ja-JP')
    expect(pickInitialLocale(['nl-NL', 'de-AT', 'en-GB'])).toBe('de-DE')
    expect(pickInitialLocale(['en-GB'])).toBe('en-US')
    expect(pickInitialLocale(['ko_KR'])).toBe('ko-KR')
  })

  it('keeps the variant of Spanish and Portuguese that the region points at', () => {
    expect(pickInitialLocale(['es-ES'])).toBe('es-ES')
    expect(pickInitialLocale(['es-MX'])).toBe('es-419')
    expect(pickInitialLocale(['es-419'])).toBe('es-419')
    expect(pickInitialLocale(['es'])).toBe('es-419')
    expect(pickInitialLocale(['pt-PT'])).toBe('pt-BR')
  })

  it('reads a tag with a script subtag', () => {
    expect(pickInitialLocale(['zh-Hans-CN', 'hi-Latn-IN'])).toBe('hi-IN')
  })

  it('starts from English when none of the preferred languages is available', () => {
    expect(pickInitialLocale(['zh-Hans-CN', 'ar-SA'])).toBe('en-US')
    expect(pickInitialLocale([])).toBe('en-US')
  })
})

describe('conversationFeatures', () => {
  it('keeps the parts that exist for Japanese alone out of every other language', () => {
    expect(conversationFeatures('ja-JP')).toEqual({ aizuchi: true, maai: true, japaneseTts: true, qwenTts: true, hallucinationList: true })
    for (const locale of CONVERSATION_LOCALES.filter((one) => one !== 'ja-JP')) {
      expect(conversationFeatures(locale)).toMatchObject({ aizuchi: false, maai: false, japaneseTts: false, hallucinationList: false })
    }
  })

  it('offers Qwen3-TTS only in the languages the model speaks', () => {
    expect(CONVERSATION_LOCALES.filter((locale) => !conversationFeatures(locale).qwenTts)).toEqual(['hi-IN', 'id-ID'])
  })
})

describe('formatLocaleOf', () => {
  it('writes times by the conventions of the region, in the language of the interface', () => {
    const at = new Date(2026, 8, 22, 18, 5)
    const time = (locale: string): string => new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(at)
    expect(time(formatLocaleOf('en-US', 'US'))).toMatch(/6:05\sPM/)
    expect(time(formatLocaleOf('en-US', 'DE'))).toBe('18:05')
    expect(formatLocaleOf('es-419', 'MX')).toBe('es-MX')
    expect(formatLocaleOf('ja-JP', 'JP')).toBe('ja-JP')
  })
})

describe('locale helpers', () => {
  it('gives every locale a country, and speech a tag the system has voices for', () => {
    for (const locale of CONVERSATION_LOCALES) expect(defaultRegion(locale)).toMatch(/^[A-Z]{2}$/)
    expect(speechTag('es-419')).toBe('es-MX')
    expect(new Intl.Locale(speechTag('pt-BR')).region).toBe('BR')
  })

  it('can select the region of every language, and names each of them through Intl', () => {
    for (const locale of CONVERSATION_LOCALES) expect(REGIONS).toContain(defaultRegion(locale))
    const names = new Intl.DisplayNames(['en-US'], { type: 'region' })
    for (const region of REGIONS) expect(names.of(region)).not.toBe(region)
  })

  it('keeps a speech engine only in the languages it can read aloud', () => {
    for (const engine of ['voicevox', 'aivisspeech', 'irodori'] as const) {
      expect(ttsEngineSpeaks('ja-JP', engine)).toBe(true)
      expect(ttsEngineSpeaks('en-US', engine)).toBe(false)
    }
    expect(ttsEngineSpeaks('hi-IN', 'qwen3tts')).toBe(false)
    expect(ttsEngineSpeaks('de-DE', 'qwen3tts')).toBe(true)
    // The macOS voice carries every language, which is what a conversation moves to.
    for (const locale of CONVERSATION_LOCALES) expect(ttsEngineSpeaks(locale, 'system')).toBe(true)
  })

  it('starts Japanese on Irodori-TTS and another language on Qwen3-TTS where a local engine has the memory', () => {
    for (const machine of [MACOS, WINDOWS]) {
      expect(defaultTtsEngine('ja-JP', machine.localSpeech)).toBe('irodori')
      expect(defaultTtsEngine('en-US', machine.localSpeech)).toBe('qwen3tts')
      // Qwen3-TTS has no Hindi, so Hindi starts on the OS's voice.
      expect(defaultTtsEngine('hi-IN', machine.localSpeech)).toBe('system')
    }
  })

  it('starts Japanese on VOICEVOX and another language on the OS\'s voice where no local engine is offered', () => {
    const smallMac = deriveCapabilities({ platform: 'darwin', arch: 'arm64', totalMemoryBytes: 8 * 1024 ** 3, speechDevices: () => null, micCancelsEcho: () => true })
    for (const machine of [smallMac, WINDOWS_WITHOUT_GPU]) {
      expect(defaultTtsEngine('ja-JP', machine.localSpeech)).toBe('voicevox')
      expect(defaultTtsEngine('en-US', machine.localSpeech)).toBe('system')
    }
  })

  it('writes the prompt in Japanese for a Japanese conversation and in English for every other', () => {
    const text = { ja: 'こんにちは', en: 'Hello' }
    expect(promptText('ja-JP', text)).toBe('こんにちは')
    expect(promptText('ko-KR', text)).toBe('Hello')
  })

  it('fills a placeholder everywhere it appears and refuses to leave one unfilled', () => {
    expect(fillPrompt('answer in {language}, always in {language}', { language: 'Korean' })).toBe('answer in Korean, always in Korean')
    // A value inserted here is not scanned again, so a marker that contains braces cannot start a loop.
    expect(fillPrompt('{a}', { a: '{a}' })).toBe('{a}')
    expect(() => fillPrompt('speak {language}', {})).toThrow('{language}')
  })
})
