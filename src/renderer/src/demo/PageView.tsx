/**
 * The HTML page in the demo. A browser has no <webview>, which the app shows the page in, so the demo shows its
 * sample page, served from the demo's own origin, in an iframe that may run scripts and nothing more.
 */
export function PageView({ url, title }: { url: string | undefined; title: string }): React.JSX.Element {
  return <iframe className="fv-html-page" src={url} sandbox="allow-scripts" title={title} />
}
