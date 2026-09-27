import { describe, expect, it } from 'vitest'
import { docsUrl } from '../src/shared/docs-links'

describe('the documentation pages the app opens', () => {
  it('opens the Japanese page for the Japanese interface', () => {
    expect(docsUrl('calendar', 'ja-JP')).toBe('https://asist-agent.com/docs/start/calendar/')
    expect(docsUrl('safety', 'ja-JP')).toBe('https://asist-agent.com/docs/privacy/safety/')
  })

  it('opens the English page for English and for every language the documentation is not written in', () => {
    expect(docsUrl('mail', 'en-US')).toBe('https://asist-agent.com/en/docs/start/mail/')
    expect(docsUrl('mail', 'de-DE')).toBe('https://asist-agent.com/en/docs/start/mail/')
    expect(docsUrl('calendar', 'es-419')).toBe('https://asist-agent.com/en/docs/start/calendar/')
    expect(docsUrl('safety', 'ko-KR')).toBe('https://asist-agent.com/en/docs/privacy/safety/')
  })
})
