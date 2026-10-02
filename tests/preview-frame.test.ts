// @vitest-environment happy-dom
// @vitest-environment-options {"settings": {"navigation": {"disableChildFrameNavigation": true}}}
// happy-dom cannot load asist-preview://, and its attempt to would print a stack trace for every frame.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startIframe } from '../src/renderer/src/panels/viewers/preview-client'
import { CONNECTED, servePreview, type PreviewReply } from '../src/renderer/src/preview/serve'

const PAGE = 'asist-preview://app/preview.html'

/** The next message a port receives. */
const nextMessage = (port: MessagePort): Promise<unknown> => new Promise((resolve) => port.addEventListener('message', ({ data }) => resolve(data), { once: true }))

/** Starts a frame and lets it load, catching what it posts to the window in the frame. */
function loadedFrame() {
  const frame = startIframe(PAGE)
  frame.port.start()
  const iframe = document.body.querySelector('iframe')!
  const posted = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined)
  iframe.dispatchEvent(new Event('load'))
  return { frame, iframe, posted }
}

/** Whether the promise has settled by the time the jobs queued before this call have run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setImmediate(() => resolve(false)))])
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('the frame of the preview page', () => {
  it('is drawn, so that its animation frames run, yet nobody sees, clicks or focuses it, and it opens no window', () => {
    const { iframe } = loadedFrame()
    const style = getComputedStyle(iframe)
    // A frame that is not drawn runs no animation frame, and pdf.js draws a page on them.
    expect([iframe.hidden, style.display === 'none', style.visibility === 'hidden']).toEqual([false, false, false])
    expect([style.position, style.left, style.top, style.width, style.height]).toEqual(['fixed', '0px', '0px', '1px', '1px'])
    expect([style.opacity, style.pointerEvents, iframe.inert]).toEqual(['0', 'none', true])
    const sandbox = [...iframe.sandbox]
    expect(sandbox).toEqual(expect.arrayContaining(['allow-scripts', 'allow-same-origin']))
    expect(sandbox.filter((token) => /popups|top-navigation|modals|forms|downloads/.test(token))).toEqual([])
  })

  it('hands its port, once it has loaded, to a page of the preview page origin alone', () => {
    const { posted } = loadedFrame()
    expect(posted).toHaveBeenCalledTimes(1)
    const [message, targetOrigin, transfer] = posted.mock.calls[0] as unknown as [unknown, string, MessagePort[]]
    expect([message, targetOrigin, transfer.length]).toEqual(['connect', PAGE, 1])
  })

  it('has gone when it loaded but its page did not connect within five seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { frame } = loadedFrame()
    vi.advanceTimersByTime(4_999)
    expect(await settled(frame.gone)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await settled(frame.gone)).toBe(true)
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it('stays while its page has connected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const { frame, posted } = loadedFrame()
    const [, , [port]] = posted.mock.calls[0] as unknown as [unknown, string, MessagePort[]]
    const connected = nextMessage(frame.port)
    servePreview(port, {})
    expect(await connected).toBe(CONNECTED)
    vi.advanceTimersByTime(60_000)
    expect(await settled(frame.gone)).toBe(false)
    frame.port.close()
  })
})

describe('the script of the preview page', () => {
  it('takes one port, from the page that embeds it, and serves the kinds under methods/ on it', async () => {
    await import('../src/renderer/src/preview/main')
    const stranger = new MessageChannel()
    dispatchEvent(new MessageEvent('message', { data: 'connect', source: null, ports: [stranger.port2] }))
    const embedder = new MessageChannel()
    embedder.port1.start()
    const connected = nextMessage(embedder.port1)
    dispatchEvent(new MessageEvent('message', { data: 'connect', source: window.parent, ports: [embedder.port2] }))
    const later = new MessageChannel()
    dispatchEvent(new MessageEvent('message', { data: 'connect', source: window.parent, ports: [later.port2] }))
    expect(await connected).toBe(CONNECTED)

    const reply = nextMessage(embedder.port1)
    embedder.port1.postMessage({ type: 'call', id: 1, key: 'k', kind: 'missing', url: 'asist-file:///a.pdf', method: 'page', args: null })
    expect(((await reply) as Extract<PreviewReply, { error: string }>).error).toContain('missing')

    const unanswered = [stranger.port1, later.port1].map((port) => {
      port.start()
      return settled(nextMessage(port))
    })
    expect(await Promise.all(unanswered)).toEqual([false, false])
    for (const port of [stranger.port1, embedder.port1, later.port1]) port.close()
  })
})
