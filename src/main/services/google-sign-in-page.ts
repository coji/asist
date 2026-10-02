import { t } from './i18n'
import { signInPage } from './oauth-loopback'

/** The page the browser shows when Google sends it back to ASIST, in the language of the interface. */
export function googleSignInPage(signedIn: boolean): string {
  return signInPage(t(signedIn ? 'calendar.google.browserDone' : 'calendar.google.browserFailed'))
}
