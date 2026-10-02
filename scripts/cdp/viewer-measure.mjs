import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { APP_PATH, connect, connectBrowser, launchChrome, sleep, waitForApp, WINDOWS } from './cdp.mjs'

/**
 * Measures one file in the files card and its focus view, in a Chrome of its own on the demo's app at window
 * size l (1440 x 828 at 2x, which makes the focus view 760 x 680), as a person opens it: the card appears, the
 * person opens the focus view, pages through it a screen at a time to the end and closes it again.
 *
 * - first: the milliseconds until the content in view is drawn, from showing the card or from pressing the
 *   card's expand button (`shown`, contentShown by default). A viewer that shows an error, a placard or a note
 *   that leaves the content out fails the measurement instead, and so does a crash of the page or of any frame
 *   in it, such as an iframe a viewer works in.
 * - screens: each screen of the focus view has to be shown in turn, after a scroll by one screen of the box that
 *   scrolls under the middle of the view, as a wheel there would scroll it; `slowestScreenMs` is the longest one
 *   took. A file whose focus view should scroll and does not fails.
 * - held: the longest time the page's main thread did not get to run, measured by a timer that asks to run
 *   every TICK_MS and read only after it has run again, so that a block still running when it is read is counted
 *   whole. It covers showing the card and the SETTLE_MS after, and separately the focus view from its opening to
 *   the end of the scroll.
 * - memory: what the renderer processes of the page hold (RSS), sampled every SAMPLE_MS: the peak while only the
 *   card is shown, the peak of the whole run, and the final once the focus view is closed and garbage is
 *   collected in the page and in every frame of it, each over what the app held before the card appeared. They
 *   include any iframe a viewer runs in a process of its own. The GPU process's peak is reported beside them.
 *   RSS keeps pages the allocator has freed but not yet given back, so the final can exceed what the page still
 *   uses. It is read with ps, which Windows does not have, so there the measurement stops with an error.
 */

/** The screens the focus view is paged through before it is scrolled to the end, as the survey of 2026-10-02 did. */
const SCREENS = 120
/** The shortest time a screen stays in view: a person paging quickly through a long document. */
const STEP_MS = 150
/** How long the page is left to finish what it started after something is shown, before it is measured. */
const SETTLE_MS = 1000
const SAMPLE_MS = 100
const TICK_MS = 5
/** How long a viewer has to show its content before the case fails, whatever its budget. */
const SHOW_TIMEOUT_MS = 120_000
/** How long one screen of the focus view has to be shown once it is scrolled into view. */
const SCREEN_TIMEOUT_MS = 30_000

/**
 * Flags that keep this Chrome from starting renderers of its own while a file is measured, for extensions,
 * components and a spare, of 100 to 130 MB each (measured 2026-10-02). One that starts during a measurement could
 * not be told from an iframe of the page's, and without these flags the renderers grew by 200 MB while a card
 * that reads nothing was shown.
 */
const QUIET = [
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  '--disable-component-update',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-features=SpareRendererForSitePerProcess'
]

const CARD = '.panel-card[data-panel-type="files"]'
const FOCUS = '.panel-focus[data-panel-type="files"]'

/**
 * Whether the content in view is drawn, evaluated in the page with the root of the card or of the focus view.
 * It stands for any viewer that a case does not describe itself, so it reads only what every viewer shares: the
 * frame, its loading note, and what can be seen of it. Nothing may still be loading in view: no loading note, no
 * picture still loading and no canvas still blank, which a canvas shrunk to 16 x 16 shows by holding one colour
 * only, as a page that is only cleared to white does. And something has to be drawn there: hit-tested on a grid
 * across what can be seen of the frame, a drawn canvas, a loaded picture or an element with text of its own,
 * outside the frame's notes, placards and controls. Empty placeholders, a loading note or a placard alone never
 * count, and whatever __budgetRefusal names, such as a waveform left out beside a drawn line, keeps the content
 * from counting as shown.
 */
function contentShown(root) {
  const frame = root.querySelector('.fv-frame')
  if (!frame || window.__budgetRefusal(root)) return false
  const loading = window.demoText('files.viewer.loading')
  if ([...frame.querySelectorAll('.fv-note')].some((note) => note.textContent.trim() === loading)) return false
  const clips = [root, frame.querySelector('.fv-scroll') ?? frame].map((el) => el.getBoundingClientRect())
  const area = {
    top: Math.max(0, ...clips.map((c) => c.top)),
    bottom: Math.min(innerHeight, ...clips.map((c) => c.bottom)),
    left: Math.max(0, ...clips.map((c) => c.left)),
    right: Math.min(innerWidth, ...clips.map((c) => c.right))
  }
  if (area.bottom <= area.top || area.right <= area.left) return false
  // A pixel at least: a page whose top lay less than a pixel above the bottom of the focus view counted as in
  // view, and the PDF viewer, rightly, never drew it there.
  const inView = (el) => {
    const r = el.getBoundingClientRect()
    return Math.min(r.bottom, area.bottom) - Math.max(r.top, area.top) >= 1 && Math.min(r.right, area.right) - Math.max(r.left, area.left) >= 1
  }
  const sample = (window.__budgetSample ??= new OffscreenCanvas(16, 16).getContext('2d', { willReadFrequently: true }))
  // Shrunk with the default smoothing, a canvas is read at a few of its pixels only, which missed the 2 px line
  // of a waveform; the high quality averages all of them.
  sample.imageSmoothingQuality = 'high'
  const drawn = (canvas) => {
    if (canvas.width === 0 || canvas.height === 0) return false
    sample.clearRect(0, 0, 16, 16)
    sample.drawImage(canvas, 0, 0, 16, 16)
    const data = sample.getImageData(0, 0, 16, 16).data
    for (let i = 4; i < data.length; i += 4) {
      if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2] || data[i + 3] !== data[3]) return true
    }
    return false
  }
  for (const img of frame.querySelectorAll('img')) if (inView(img) && !(img.complete && img.naturalWidth > 0)) return false
  for (const canvas of frame.querySelectorAll('canvas')) if (inView(canvas) && !drawn(canvas)) return false
  const aside = '.fv-note, .fv-stub, button, [role="tab"], [role="tablist"]'
  const content = (el) =>
    el instanceof HTMLCanvasElement ||
    (el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0) ||
    [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '')
  for (let row = 1; row <= 4; row++) {
    for (let column = 1; column <= 4; column++) {
      const x = area.left + ((area.right - area.left) * column) / 5
      const y = area.top + ((area.bottom - area.top) * row) / 5
      const hit = document.elementFromPoint(x, y)
      if (hit && frame.contains(hit) && !hit.closest(aside) && content(hit)) return true
    }
  }
  return false
}

/**
 * Installs the timer that measures how long the main thread is held, and __budgetRefusal(root), which names what a
 * viewer shows in place of its content: an error note, a placard (the files card's StubViewer and its too-large
 * viewer), or a note saying the content was left out because the file is too large, matched against the
 * dictionary's wording in whatever language the page shows.
 */
const PROBE = `(() => {
  const probe = { held: 0, last: performance.now(), waiting: [] }
  setInterval(() => {
    const now = performance.now()
    probe.held = Math.max(probe.held, now - probe.last - ${TICK_MS})
    probe.last = now
    for (const resolve of probe.waiting.splice(0)) resolve()
  }, ${TICK_MS})
  probe.tick = () => new Promise((resolve) => probe.waiting.push(resolve))
  window.__budgetProbe = probe
  const wording = (key) => window.demoText(key, { size: '\\u0001' }).split('\\u0001').filter(Boolean)
  const leftOut = ['files.viewer.tooLarge', 'files.viewer.waveformTooLarge'].map(wording)
  window.__budgetRefusal = (root) => {
    const error = root.querySelector('.fv-note[data-tone="error"]')
    if (error) return 'the viewer showed an error: ' + error.textContent.trim()
    const placard = root.querySelector('.fv-stub')
    if (placard) return 'the viewer showed a placard instead of the content: ' + placard.innerText.replace(/\\s+/g, ' ').trim()
    const note = [...root.querySelectorAll('.fv-note')].find((n) => leftOut.some((parts) => parts.every((part) => n.textContent.includes(part))))
    if (note) return 'the viewer left the content out: ' + note.textContent.trim()
    return null
  }
  return null
})()`
const resetHeld = `window.__budgetProbe.tick().then(() => { window.__budgetProbe.held = 0; return null })`
const readHeld = `window.__budgetProbe.tick().then(() => Math.round(window.__budgetProbe.held))`

/**
 * An expression that runs `action` and resolves with `{ ms }`, the milliseconds until `check(root)` holds for the
 * element of `selector`, checked at every frame, or with `{ failed }` when the viewer shows something in place of
 * its content or nothing comes in time.
 */
function timed(action, selector, check, mode, what) {
  return `new Promise((resolve) => {
    const check = ${check}
    const started = performance.now()
    ${action}
    const poll = () => {
      const root = document.querySelector(${JSON.stringify(selector)})
      if (root && check(root, ${JSON.stringify(mode)})) return resolve({ ms: Math.round(performance.now() - started) })
      const refused = root && window.__budgetRefusal(root)
      if (refused) return resolve({ failed: ${JSON.stringify(what)} + ': ' + refused })
      if (performance.now() - started > ${SHOW_TIMEOUT_MS}) return resolve({ failed: ${JSON.stringify(`${what}: nothing was shown within ${SHOW_TIMEOUT_MS / 1000} s`)} })
      requestAnimationFrame(poll)
    }
    poll()
  })`
}

/** The value of an expression that resolves with `{ failed }` when what it waited for failed, which this throws. */
function succeeded(value) {
  if (value.failed) throw new Error(value.failed)
  return value
}

/**
 * An expression that pages through the focus view and resolves with how many screens it scrolled, the longest a
 * screen took to be shown, and the height it scrolled through, or with `{ failed }` when a screen was not shown.
 * The box that scrolls is the one a wheel over the
 * middle of the view would scroll: the nearest one there with more to show, which is the focus view itself, or a
 * box inside it such as a grid that scrolls on its own.
 */
function paged(check) {
  return `(async () => {
    const check = ${check}
    const root = document.querySelector(${JSON.stringify(FOCUS)})
    const scrolls = (el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1
    const middle = root.getBoundingClientRect()
    let scroller = document.elementFromPoint(middle.left + middle.width / 2, middle.top + middle.height / 2)
    while (scroller && root.contains(scroller) && !scrolls(scroller)) scroller = scroller.parentElement
    if (!scroller || !root.contains(scroller)) return { screens: 0, slowestScreenMs: 0, heightPx: 0 }
    const shown = (where) =>
      new Promise((resolve) => {
        const started = performance.now()
        const poll = () => {
          if (check(root, 'focus')) return resolve({ ms: performance.now() - started })
          const refused = window.__budgetRefusal(root)
          if (refused) return resolve({ failed: where + ': ' + refused })
          if (performance.now() - started > ${SCREEN_TIMEOUT_MS}) return resolve({ failed: where + ': nothing was shown within ${SCREEN_TIMEOUT_MS / 1000} s' })
          requestAnimationFrame(poll)
        }
        poll()
      })
    let screens = 0
    let slowest = 0
    while (screens < ${SCREENS}) {
      const before = scroller.scrollTop
      scroller.scrollTop += scroller.clientHeight
      if (scroller.scrollTop === before) break
      screens += 1
      const screen = await shown('screen ' + screens + ' of the focus view')
      if (screen.failed) return screen
      slowest = Math.max(slowest, screen.ms)
      if (screen.ms < ${STEP_MS}) await new Promise((resolve) => setTimeout(resolve, ${STEP_MS} - screen.ms))
    }
    scroller.scrollTop = scroller.scrollHeight
    const end = await shown('the end of the focus view')
    if (end.failed) return end
    slowest = Math.max(slowest, end.ms)
    return { screens, slowestScreenMs: Math.round(slowest), heightPx: Math.round(scroller.scrollHeight) }
  })()`
}

const execFileAsync = promisify(execFile)

/**
 * The resident memory of each process, in MB, read with ps. A process that ended after Chrome listed it is
 * missing from the answer, which counts it as holding nothing, as it no longer does; ps then exits with 1 but
 * still prints the others.
 */
async function residentMb(pids) {
  if (pids.length === 0) return new Map()
  if (process.platform === 'win32') throw new Error('メモリは ps で測ります。Windows では測れません')
  const stdout = await execFileAsync('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], { windowsHide: true }).then(
    (result) => result.stdout,
    (error) => {
      if (error.code === 1 && error.stdout !== undefined) return error.stdout
      throw error
    }
  )
  const rows = stdout.trim().split('\n').filter(Boolean).map((line) => line.trim().split(/\s+/).map(Number))
  if (rows.some((row) => row.length !== 2 || row.some((value) => !Number.isFinite(value)))) throw new Error(`ps の出力を読めません: ${stdout}`)
  return new Map(rows.map(([pid, kb]) => [pid, kb / 1024]))
}

/** The process ids of this Chrome, by type: renderer, GPU and so on. */
async function processes(browser) {
  const { processInfo } = await browser.send('SystemInfo.getProcessInfo')
  return (type) => processInfo.filter((p) => p.type === type).map((p) => p.id)
}

/**
 * The renderers of this Chrome that do not serve the page. Headless Chrome keeps a renderer of its own for the
 * WebUI of the omnibox popup, about 200 MB, which no flag removes and which once gave up 180 MB in the middle of
 * a measurement (2026-10-02). The page's own renderers are those a trace names for its frames; every other
 * renderer that exists before the card is shown is left out of the sums, and one that starts later, such as an
 * iframe's, is counted.
 */
async function foreignRenderers(browser, client) {
  const events = []
  let finished
  const complete = new Promise((resolve) => {
    finished = resolve
  })
  const stop = client.onEvent((msg) => {
    if (msg.method === 'Tracing.dataCollected') events.push(...msg.params.value)
    if (msg.method === 'Tracing.tracingComplete') finished()
  })
  await client.send('Tracing.start', { traceConfig: { includedCategories: ['disabled-by-default-devtools.timeline'] }, transferMode: 'ReportEvents' })
  await client.send('Tracing.end')
  await complete
  stop()
  const frames = events.find((event) => event.name === 'TracingStartedInBrowser')?.args.data.frames ?? []
  const page = new Set(frames.map((frame) => frame.processId))
  const renderers = (await processes(browser))('renderer')
  if (!renderers.some((pid) => page.has(pid))) throw new Error(`トレースが名指したページのレンダラー (${[...page].join(', ')}) が Chrome のレンダラー (${renderers.join(', ')}) にありません`)
  return new Set(renderers.filter((pid) => !page.has(pid)))
}

async function memory(browser, foreign) {
  const ids = await processes(browser)
  const renderers = ids('renderer').filter((pid) => !foreign.has(pid))
  const gpu = ids('GPU')
  const rss = await residentMb([...renderers, ...gpu])
  const total = (list) => list.reduce((sum, pid) => sum + (rss.get(pid) ?? 0), 0)
  return { renderer: total(renderers), gpu: total(gpu) }
}

/** Samples the memory until stopped and keeps the peaks. A failed sample fails the measurement when it stops. */
function sampler(browser, foreign) {
  let running = true
  const peak = { renderer: 0, gpu: 0 }
  const done = (async () => {
    while (running) {
      const now = await memory(browser, foreign)
      peak.renderer = Math.max(peak.renderer, now.renderer)
      peak.gpu = Math.max(peak.gpu, now.gpu)
      await sleep(SAMPLE_MS)
    }
  })()
  done.catch(() => {})
  return {
    peak,
    stop: async () => {
      running = false
      await done
    }
  }
}

/** The median of three samples a little apart, which keeps a passing spike out of a resting value. */
async function resting(browser, foreign) {
  const samples = []
  for (let i = 0; i < 3; i++) {
    samples.push(await memory(browser, foreign))
    await sleep(SAMPLE_MS)
  }
  const median = (key) => samples.map((s) => s[key]).sort((a, b) => a - b)[1]
  return { renderer: median('renderer'), gpu: median('gpu') }
}

/**
 * Collects the garbage of the page and of every frame of it in a process of its own. The page's collection does
 * not reach an out-of-process iframe: 100 MB of garbage in one stayed after it and went with one through the
 * iframe's own target (2026-10-02).
 */
async function collectGarbage(browser, client) {
  await client.send('HeapProfiler.collectGarbage')
  const { targetInfos } = await browser.send('Target.getTargets')
  for (const target of targetInfos.filter((info) => info.type === 'iframe')) {
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    await browser.send('HeapProfiler.collectGarbage', {}, sessionId)
    await browser.send('Target.detachFromTarget', { sessionId })
  }
}

/**
 * Measures the file served at `url` and shown as `path`. `shown(root, mode)` and `complete(root)` are functions
 * evaluated in the page, so they use nothing from outside their own body. `scrolls` says whether the file's focus
 * view has more than a screen to page through, which a recording or a placard does not.
 */
export async function measureFile({ origin, path, url, sizeBytes, scrolls = true, shown = contentShown, complete = null }) {
  const chrome = await launchChrome({ args: QUIET })
  const browser = await connectBrowser(chrome.port)
  const client = await connect(chrome.port)
  // A crash of the page or of any frame in it, such as an iframe a viewer works in, fails the measurement, even
  // when the page goes on and shows something else.
  let crashed
  let crashError = null
  const crash = new Promise((_, reject) => {
    crashed = reject
  })
  crash.catch(() => {})
  const urls = new Map()
  browser.onEvent((msg) => {
    if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') urls.set(msg.params.targetInfo.targetId, msg.params.targetInfo.url)
    if (msg.method === 'Target.targetCrashed') {
      crashError ??= new Error(`a frame crashed (${msg.params.status}): ${urls.get(msg.params.targetId) ?? msg.params.targetId}`)
      crashed(crashError)
    }
  })
  const guard = (promise) => Promise.race([promise, crash])
  let samples = null
  try {
    await browser.send('Target.setDiscoverTargets', { discover: true })
    await client.resize(WINDOWS.l)
    await client.navigate(new URL(APP_PATH, origin).href)
    await waitForApp(client)
    await client.evaluate(PROBE)
    await sleep(SETTLE_MS)
    await collectGarbage(browser, client)
    const foreign = await foreignRenderers(browser, client)
    const baseline = await resting(browser, foreign)
    if (!(baseline.renderer > 0)) throw new Error(`ページのレンダラーのメモリを読めません: ${baseline.renderer}`)
    samples = sampler(browser, foreign)

    const show = `window.demoShowFile(${JSON.stringify({ path, url, sizeBytes })})`
    await client.evaluate(resetHeld)
    const card = { firstMs: succeeded(await guard(client.evaluate(timed(show, CARD, shown, 'card', 'the card')))).ms }
    if (complete) card.completeMs = card.firstMs + succeeded(await guard(client.evaluate(timed('', CARD, complete, 'card', 'the card')))).ms
    await sleep(SETTLE_MS)
    card.heldMs = await guard(client.evaluate(readHeld))
    card.widthPx = await client.evaluate(`Math.round(document.querySelector(${JSON.stringify(CARD)}).getBoundingClientRect().width)`)
    const cardPeak = samples.peak.renderer

    const expand = `document.querySelector(${JSON.stringify(CARD)} + ' button[aria-label="' + CSS.escape(window.demoText('panels.expand')) + '"]').click()`
    await client.evaluate(resetHeld)
    const focus = { firstMs: succeeded(await guard(client.evaluate(timed(expand, FOCUS, shown, 'focus', 'the focus view')))).ms }
    Object.assign(focus, succeeded(await guard(client.evaluate(paged(shown)))))
    if (scrolls && focus.screens === 0) throw new Error('the focus view did not scroll, though the file has more than a screen to show')
    await sleep(SETTLE_MS)
    focus.heldMs = await guard(client.evaluate(readHeld))

    await client.evaluate(`document.querySelector(${JSON.stringify(FOCUS)} + ' button[aria-label="' + CSS.escape(window.demoText('panels.closeFocus')) + '"]').click()`)
    await sleep(SETTLE_MS)
    await guard(collectGarbage(browser, client))
    await sleep(SETTLE_MS)
    await samples.stop()
    const final = await resting(browser, foreign)
    // A frame that crashed after the last wait still fails the measurement.
    if (crashError) throw crashError
    const mb = (value) => Math.round(value)
    return {
      card,
      focus,
      memory: {
        baselineMb: mb(baseline.renderer),
        cardPeakMb: mb(cardPeak - baseline.renderer),
        peakMb: mb(samples.peak.renderer - baseline.renderer),
        finalMb: mb(final.renderer - baseline.renderer),
        gpuPeakMb: mb(samples.peak.gpu - baseline.gpu)
      }
    }
  } finally {
    await samples?.stop().catch(() => {})
    client.close()
    browser.close()
    await chrome.close()
  }
}
