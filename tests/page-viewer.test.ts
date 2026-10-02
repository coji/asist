import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The session the files card's HTML page is shown in: every <webview> of the app's page is attached in it, the
 * page's renderer does no DNS prefetching, every request but one for an allowed file is cancelled, WebRTC sends
 * nothing over UDP and its TCP goes to a proxy no connection reaches, and the page cannot navigate, open a
 * window or be granted a permission.
 */

type BeforeRequest = (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void

const mocks = vi.hoisted(() => {
  const viewer = {
    protocol: { handle: vi.fn() },
    setProxy: vi.fn(() => Promise.resolve()),
    webRequest: { onBeforeRequest: vi.fn() },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setSpellCheckerEnabled: vi.fn()
  }
  return { viewer, fromPartition: vi.fn(() => viewer), appOn: vi.fn() }
})

vi.mock('electron', () => ({
  app: { on: mocks.appOn },
  session: { fromPartition: mocks.fromPartition },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }
}))

class FakeContents extends EventEmitter {
  constructor(private readonly type: string) {
    super()
  }
  getType = (): string => this.type
  setWebRTCIPHandlingPolicy = vi.fn()
  setWindowOpenHandler = vi.fn()
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

/** Sets the viewer up and returns what a webContents created afterwards is given. */
async function setUp() {
  const { setUpPageViewer } = await import('../src/main/page-viewer')
  await setUpPageViewer(() => ['/r'])
  const created = mocks.appOn.mock.calls.find(([name]) => name === 'web-contents-created')![1] as (event: unknown, contents: FakeContents) => void
  const create = (type: string): FakeContents => {
    const contents = new FakeContents(type)
    created({}, contents)
    return contents
  }
  const partition = (mocks.fromPartition.mock.calls[0] as unknown[])[0] as string
  return { create, partition }
}

/** Asks the embedder to attach a webview and returns whether it was refused and the preferences it gets. */
function attach(embedder: FakeContents, src: string, requested: Record<string, unknown>) {
  const event = { preventDefault: vi.fn() }
  const webPreferences = { ...requested }
  embedder.emit('will-attach-webview', event, webPreferences, { src })
  return { refused: event.preventDefault.mock.calls.length > 0, webPreferences }
}

describe('the session the page is shown in', () => {
  it('is kept in memory, so the page leaves nothing on disk', async () => {
    const { partition } = await setUp()
    expect(partition.startsWith('persist:')).toBe(false)
  })

  it('cancels every request but one for an allowed file, whatever host or scheme it names', async () => {
    await setUp()
    const listener = mocks.viewer.webRequest.onBeforeRequest.mock.calls[0][0] as BeforeRequest
    const cancelled = (url: string): boolean => {
      let answer: boolean | undefined
      listener({ url }, ({ cancel }) => (answer = cancel))
      return answer!
    }
    for (const url of [
      'https://prefetch-check.invalid/x.png',
      'http://192.168.1.10/',
      'wss://prefetch-check.invalid/ws',
      'ws://127.0.0.1:8080/',
      'file:///etc/passwd',
      'ftp://prefetch-check.invalid/'
    ]) {
      expect([url, cancelled(url)]).toEqual([url, true])
    }
    expect(cancelled('asist-file:///r/report/chart.js')).toBe(false)
  })

  it('sends any connection that is not a request to a proxy no connection reaches, this machine included', async () => {
    await setUp()
    const config = mocks.viewer.setProxy.mock.calls[0][0] as { mode: string; proxyRules: string; proxyBypassRules: string }
    expect(config.mode).toBe('fixed_servers')
    // One proxy and no direct way out: the OS refuses a connection to port 0.
    const proxies = config.proxyRules.split(/[;,]/).map((rule) => rule.trim())
    expect(proxies).toHaveLength(1)
    expect(new URL(proxies[0]).port).toBe('0')
    expect(proxies[0]).not.toMatch(/direct/i)
    // Chromium connects to this machine directly unless the implicit exception is taken away.
    expect(config.proxyBypassRules.split(/[;,]/).map((rule) => rule.trim())).toEqual(['<-loopback>'])
  })

  it('is cut off before any page can load in it', async () => {
    let finish = (): void => undefined
    mocks.viewer.setProxy.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
    const { setUpPageViewer } = await import('../src/main/page-viewer')
    let ready = false
    const setting = setUpPageViewer(() => []).then(() => (ready = true))
    await Promise.resolve()
    expect(ready).toBe(false)
    finish()
    await setting
    expect(ready).toBe(true)
  })

  it('grants the page no permission and no device', async () => {
    await setUp()
    const request = mocks.viewer.setPermissionRequestHandler.mock.calls[0][0] as (c: unknown, p: string, callback: (granted: boolean) => void) => void
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal']) {
      const callback = vi.fn()
      request({}, permission, callback)
      expect(callback).toHaveBeenCalledWith(false)
    }
    expect((mocks.viewer.setPermissionCheckHandler.mock.calls[0][0] as (...args: unknown[]) => boolean)({}, 'media', '', {})).toBe(false)
    expect((mocks.viewer.setDevicePermissionHandler.mock.calls[0][0] as (...args: unknown[]) => boolean)({})).toBe(false)
  })
})

describe('a webview of the app page', () => {
  it('is attached in the cut-off session with no preload, no Node and DNS prefetching off, whatever its tag asks for', async () => {
    const { create, partition } = await setUp()
    const embedder = create('window')
    const { refused, webPreferences } = attach(embedder, 'asist-file:///r/report/index.html', {
      partition: 'persist:anything',
      preload: '/tmp/bridge.js',
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      enableBlinkFeatures: 'SomethingExperimental'
    })
    expect(refused).toBe(false)
    expect(webPreferences).toMatchObject({
      partition,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    })
    expect(webPreferences.preload).toBeUndefined()
    expect(webPreferences.enableBlinkFeatures).toBeUndefined()
    expect(webPreferences.additionalArguments).toContain('--blink-settings=dnsPrefetchingEnabled=false')
  })

  it('is refused when it would show anything but an allowed file', async () => {
    const { create } = await setUp()
    const embedder = create('window')
    for (const src of ['https://example.com/', 'file:///Users/me/report.html', 'data:text/html,<p>x</p>', '']) {
      expect([src, attach(embedder, src, {}).refused]).toEqual([src, true])
    }
  })
})

describe('the page in a webview', () => {
  it('sends nothing over UDP from WebRTC, which no proxy carries', async () => {
    const { create } = await setUp()
    const page = create('webview')
    expect(page.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp')
  })

  it('opens no window and cannot navigate, in its own frame or any other', async () => {
    const { create } = await setUp()
    const page = create('webview')
    const opener = page.setWindowOpenHandler.mock.calls[0][0] as (details: { url: string }) => { action: string }
    expect(opener({ url: 'https://prefetch-check.invalid/' }).action).toBe('deny')
    for (const isMainFrame of [true, false]) {
      const event = { isMainFrame, url: 'https://prefetch-check.invalid/', preventDefault: vi.fn() }
      page.emit('will-frame-navigate', event)
      expect(event.preventDefault).toHaveBeenCalled()
    }
  })

  it('is confined only when it is a webview, leaving the app page its own settings', async () => {
    const { create } = await setUp()
    const window = create('window')
    expect(window.setWebRTCIPHandlingPolicy).not.toHaveBeenCalled()
    expect(window.listenerCount('will-frame-navigate')).toBe(0)
  })
})
