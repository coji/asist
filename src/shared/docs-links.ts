import type { UiLocale } from './i18n/message'

/** The pages of the documentation at asist-agent.com that the app opens. */
export type DocsPage = 'calendar' | 'mail' | 'safety'

const PAGES: Record<DocsPage, string> = {
  calendar: 'start/calendar/',
  mail: 'start/mail/',
  safety: 'privacy/safety/'
}

/**
 * The address of a documentation page in the interface language. The documentation is written in Japanese
 * and English only, so every other language opens the English page.
 */
export function docsUrl(page: DocsPage, uiLocale: UiLocale): string {
  const prefix = uiLocale === 'ja-JP' ? '' : '/en'
  return `https://asist-agent.com${prefix}/docs/${PAGES[page]}`
}
