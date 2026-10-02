/**
 * The page the files card's viewers do their heavy work in, inside an iframe nobody sees: parsing a document,
 * decoding its pictures, drawing its pages. main serves it on a scheme of its own, a site apart from the app's
 * page, so that Chromium runs the frame in a process of its own and a file that takes it out of memory ends
 * the frame rather than the app's page. The app's CSP names the origin in frame-src as well.
 */
export const PREVIEW_ORIGIN = 'asist-preview://app'

/** The page's path in the renderer's build, and its name under the origin. */
export const PREVIEW_PAGE = 'preview.html'

export const PREVIEW_PAGE_URL = `${PREVIEW_ORIGIN}/${PREVIEW_PAGE}`

/**
 * The content security policy of the preview page and of every script it loads: it runs its own scripts and
 * reads the user's files over asist-file:, and loads, sends or embeds nothing else. It goes out as a header
 * with every response of the origin, because a worker takes its policy from its own script's response and a
 * page's meta tag never reaches it.
 */
export const PREVIEW_POLICY = "default-src 'none'; script-src 'self'; connect-src asist-file:"

/** The list of the preview page's files that the renderer's build writes next to the page. */
export const PREVIEW_FILES = 'preview-files.json'
