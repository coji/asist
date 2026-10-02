import { app, session, type Event, type WebContents, type WebPreferences } from 'electron'
import { FILE_SCHEME, handleFileScheme } from './file-protocol'

/**
 * The session the HTML page of the files card is shown in, which reaches no network. The page is a <webview>
 * of the app's page, and every <webview> is attached in this session whatever its tag asks for, so a document
 * from an allowed folder is never rendered in the app's own session. The policy the document is served with
 * (documentPolicy) refuses every remote source; the session closes what a policy does not reach, each measured
 * in Electron 43.7.7 on 2026-10-02:
 *
 * - A `<link rel="dns-prefetch">` makes the network service look its host up without any request, which
 *   X-DNS-Prefetch-Control, a proxy, webRequest, the session's preconnect event and network emulation all left
 *   in place. Only turning DNS prefetching off in the page's renderer stopped it.
 * - WebRTC is not governed by the policy. Over UDP it reached any address the page named; over TCP it goes
 *   through the session's proxy, which leads nowhere.
 * - A navigation, prefetch or resource the policy misses is a request, which webRequest cancels.
 *
 * WebRTC still asks the OS resolver for a host name the page writes as an ICE server or a remote candidate,
 * and nothing is sent to the host. Nothing in Electron stops that for one session or one renderer: Chromium 150
 * ignores a `webrtc` directive in the policy as unrecognised, turning off every WebRTC runtime feature of Blink
 * leaves RTCPeerConnection in place, and WebRTC asks for no permission.
 */

/** In memory: the page leaves nothing on disk. */
const PARTITION = 'asist-page-viewer'

/** A proxy no connection reaches: the OS refuses to connect to port 0 before any packet is sent. */
const UNREACHABLE_PROXY = 'http://127.0.0.1:0'

/**
 * The renderer setting that stops DNS prefetching, both the explicit `<link rel="dns-prefetch">` and the
 * prefetching of a document's links. It reaches only the renderer of the webview's page, since a renderer
 * never holds pages of two sessions.
 */
const NO_DNS_PREFETCH = '--blink-settings=dnsPrefetchingEnabled=false'

/**
 * Prepares the session, serves allowed files in it and attaches every <webview> to it. Has to finish before the
 * first window is created, so that no page loads before the session is cut off.
 */
export async function setUpPageViewer(allowedRoots: () => string[]): Promise<void> {
  const viewer = session.fromPartition(PARTITION)
  handleFileScheme(viewer.protocol, allowedRoots)
  // <-loopback> takes away the exception Chromium makes for this machine, which WebRTC would connect to directly.
  await viewer.setProxy({ mode: 'fixed_servers', proxyRules: UNREACHABLE_PROXY, proxyBypassRules: '<-loopback>' })
  // The page's own files come through here; its data: and blob: URLs never do.
  viewer.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${FILE_SCHEME}:`) }))
  viewer.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  viewer.setPermissionCheckHandler(() => false)
  viewer.setDevicePermissionHandler(() => false)
  // Outside macOS a session downloads its spelling dictionaries from Google's servers.
  viewer.setSpellCheckerEnabled(false)
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', attachInViewer)
    // The page is confined as its webContents is created, before the webview loads it.
    if (contents.getType() === 'webview') confinePage(contents)
  })
}

/** Attaches the webview in the viewer session with the preferences of a confined page, whatever its tag asked for. */
function attachInViewer(event: Event, webPreferences: WebPreferences, params: Record<string, string>): void {
  if (!params.src?.startsWith(`${FILE_SCHEME}:`)) {
    event.preventDefault()
    return
  }
  delete webPreferences.preload
  delete webPreferences.enableBlinkFeatures
  Object.assign(webPreferences, {
    partition: PARTITION,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    spellcheck: false,
    additionalArguments: [NO_DNS_PREFETCH]
  } satisfies WebPreferences)
}

function confinePage(page: WebContents): void {
  page.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  page.setWindowOpenHandler(() => ({ action: 'deny' }))
  // The page is a fixed view of one file. A navigation the page starts could move it to a file in another
  // folder or to a type served without the policy; the load the webview itself starts is not one of these.
  page.on('will-frame-navigate', (event) => event.preventDefault())
}
