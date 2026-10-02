import { servePreview, type OpenPreviewDocument } from './serve'

/**
 * The script of the preview page. The page that embeds it hands it one MessagePort, and it answers the viewers
 * on that port with the kinds under methods/.
 */

const kinds = import.meta.glob<{ default: OpenPreviewDocument }>('./methods/*.ts')

addEventListener('message', function connect(event: MessageEvent) {
  // Every frame in the window can post to this one, a remote page inside the map card included, and the port
  // reads the user's files, so it is taken only from the page that embeds this one.
  if (event.source !== window.parent || event.ports.length !== 1) return
  removeEventListener('message', connect)
  servePreview(event.ports[0], kinds)
})
