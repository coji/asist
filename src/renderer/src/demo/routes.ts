/**
 * The URL rules of the demo. The path says what is being looked at, and the query only says how to look
 * at it.
 *
 * - /                         The shell with the list of samples, opening on the conversation screen.
 * - /cards  /cards/<sample>   The shell with the card samples, either all of them or one.
 * - /screens/<screen>         The shell with the app opened on that screen and state; views.ts holds the names.
 * - /preview/cards[/<sample>] What the shell shows in its iframe. The capture scripts open it directly, and ?type= narrows it to one card type.
 * - /preview/screens/<screen> The same, for a screen.
 * - /app                      The app without the shell, driven by typing. ?say=<utterance> sends utterances in order at startup.
 * - /i18n                     Every message of the UI dictionary with its languages side by side. ?group= and ?q= narrow it.
 * - /aizuchi                  The review of the aizuchi clips the app ships, which the development server reads and writes.
 *
 * Prefixing a shell URL with /preview gives the URL loaded in the iframe.
 */
export type DemoRoute =
  | { kind: 'shell'; entry: string }
  | { kind: 'app' }
  | { kind: 'i18n' }
  | { kind: 'aizuchi' }
  | { kind: 'cards'; card: string | null }
  | { kind: 'screen'; name: string }

export const APP_PATH = '/app'
export const I18N_PATH = '/i18n'
export const AIZUCHI_PATH = '/aizuchi'
export const CARDS_PATH = '/cards'
export const SCREENS_PATH = '/screens'
const PREVIEW = '/preview'

/**
 * The host the demo serves the viewers' preview page from (src/renderer/preview.html). It is a site apart from the
 * demo's localhost, as asist-preview:// is apart from the app's page, so that Chrome runs the page's frame in a
 * process of its own here too. Chrome takes every name under localhost for this machine.
 */
export const PREVIEW_PAGE_HOST = 'preview.localhost'

export const cardPath = (id: string): string => `${CARDS_PATH}/${id}`
export const screenPath = (name: string): string => `${SCREENS_PATH}/${name}`
/** The sample / opens on. The full card list is heavy, so the shell starts on the conversation screen. */
export const HOME_ENTRY = screenPath('conversation')
export const previewPath = (entry: string): string => `${PREVIEW}${entry}`

const under = (pathname: string, base: string): string | null =>
  pathname === base ? '' : pathname.startsWith(`${base}/`) ? decodeURIComponent(pathname.slice(base.length + 1)) : null

export function resolveDemoRoute(pathname: string): DemoRoute {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  if (path === APP_PATH) return { kind: 'app' }
  if (path === I18N_PATH) return { kind: 'i18n' }
  if (path === AIZUCHI_PATH) return { kind: 'aizuchi' }
  const previewCard = under(path, `${PREVIEW}${CARDS_PATH}`)
  if (previewCard !== null) return { kind: 'cards', card: previewCard || null }
  const previewScreen = under(path, `${PREVIEW}${SCREENS_PATH}`)
  if (previewScreen) return { kind: 'screen', name: previewScreen }
  if (path === '/') return { kind: 'shell', entry: HOME_ENTRY }
  if (under(path, CARDS_PATH) !== null || under(path, SCREENS_PATH)) return { kind: 'shell', entry: path }
  throw new Error(`demo に ${pathname} というページはありません`)
}
