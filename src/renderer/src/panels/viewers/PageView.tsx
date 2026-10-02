/**
 * The HTML page itself. A <webview> runs its page in a webContents of its own, which main attaches in a
 * session that reaches no network, whatever the tag asks for; an iframe would run the page in the app's own
 * session, which the network is open to. The page's sandbox is the one its policy names, since a webview has
 * no sandbox attribute.
 */
export function PageView({ url, title }: { url: string | undefined; title: string }): React.JSX.Element {
  return <webview className="fv-html-page" src={url} title={title} />
}
