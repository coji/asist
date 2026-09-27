import { t } from './i18n'

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The page the browser shows when Google sends it back to ASIST, in the language of the interface. */
export function googleSignInPage(signedIn: boolean): string {
  const text = escapeHtml(t(signedIn ? 'calendar.google.browserDone' : 'calendar.google.browserFailed'))
  return `<!doctype html><html><head><meta charset="utf-8"><title>ASIST</title></head><body><p>${text}</p></body></html>`
}
