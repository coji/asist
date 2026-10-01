import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * A thin shared layer over the Chrome DevTools Protocol. It connects the same way to the headless Chrome
 * that shows the demo and to ASIST itself started with --remote-debugging-port. It depends on nothing
 * beyond Node 22's fetch and WebSocket.
 */

/** Where Chrome is installed on this OS, unless CHROME_BIN names another one. */
function chromePath() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN
  const candidates =
    process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : process.platform === 'win32'
        ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
            .filter(Boolean)
            .map((dir) => path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'))
        : []
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error('Chrome が見つかりません。CHROME_BIN に実行ファイルの場所を書いてください')
  return found
}

/**
 * The paths of the demo. They resolve against the demo a run starts for itself, or, when a run attaches to
 * a Chrome that is already open, against the page that Chrome shows.
 */
/** The app without the demo shell, which is what you talk to by typing. */
export const APP_PATH = '/app'
/** The page the shell shows in its iframe. A capture opens it directly instead of going through the shell. */
export const previewPath = (entry) => `/preview${entry}`

/**
 * The named window sizes. `l` is the height of a maximized window on a 1440x900 screen, `s` is the
 * smallest window the app allows, which is minHeight in src/main/index.ts, and `m` sits between them. The
 * demo shell shows the same values.
 */
export const WINDOWS = JSON.parse(readFileSync(new URL('../../src/renderer/src/demo/window-sizes.json', import.meta.url), 'utf8'))

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Turns a name such as "l", or a width by height such as "1280x720", into [width, height]. */
export function windowSize(value) {
  if (WINDOWS[value]) return WINDOWS[value]
  const match = /^(\d+)x(\d+)$/.exec(value)
  if (!match) throw new Error(`ウィンドウの大きさは l/m/s か 幅x高さ で指定します: ${value}`)
  return [Number(match[1]), Number(match[2])]
}

/** Starts headless Chrome with a CDP port and returns that port. Port 0 picks a free one. */
export async function launchChrome({ port = 0, url = 'about:blank' } = {}) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'asist-chrome-'))
  const child = spawn(chromePath(), [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    url
  ])
  // Chrome is never left behind, however this process ends.
  process.on('exit', () => {
    try {
      child.kill('SIGKILL')
    } catch {
      // The process has already ended.
    }
  })
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = ''
    child.stderr.on('data', (chunk) => {
      buffer += chunk
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) resolve(match[1])
    })
    child.on('exit', (code) => reject(new Error(`Chrome が終了しました: ${code}`)))
  })
  return { child, port: Number(new URL(wsUrl).port) }
}

/** Connects to the first page target on the port. */
export async function connect(port) {
  let targets
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  } catch {
    throw new Error(
      `127.0.0.1:${port} に CDP がありません。npm run demo:open か、--remote-debugging-port=${port} 付きのアプリを起動してください`
    )
  }
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('page target がありません')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('CDP に接続できません')))
  })
  let seq = 0
  const pending = new Map()
  /**
   * The last navigation, or the page as it was when connected: its URL, when it began, and since then the
   * uncaught errors of the page and the errors the browser logged, such as a module it could not load.
   * waitForApp reports them when the page never renders.
   */
  let navigation = { url: page.url, at: Date.now(), exceptions: [], logged: [] }
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.method === 'Runtime.exceptionThrown') {
      const details = msg.params.exceptionDetails
      navigation.exceptions.push({ at: Date.now(), text: details.exception?.description ?? details.text })
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      const { text, url } = msg.params.entry
      navigation.logged.push(url ? `${text} ${url}` : text)
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
  await send('Log.enable')
  return {
    send,
    async evaluate(expression) {
      const { result, exceptionDetails } = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      })
      if (exceptionDetails) {
        throw new Error(`${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ''}`)
      }
      return result.value
    },
    navigate: (url) => {
      navigation = { url, at: Date.now(), exceptions: [], logged: [] }
      return send('Page.navigate', { url })
    },
    navigation: () => navigation,
    /** Pretends the window has this size. It is for the demo, and never for the app's own window. */
    resize: ([width, height]) =>
      send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false }),
    /**
     * A PNG, or a WebP when a quality from 0 to 100 is given, which Chrome encodes itself. A clip, in CSS
     * pixels, keeps only that rectangle, still at the device scale of the page.
     */
    async screenshot({ webpQuality, clip } = {}) {
      const params = webpQuality === undefined ? { format: 'png' } : { format: 'webp', quality: webpQuality }
      if (clip) params.clip = { ...clip, scale: 1 }
      const { data } = await send('Page.captureScreenshot', params)
      return Buffer.from(data, 'base64')
    },
    close: () => ws.close()
  }
}

/**
 * What a rendered page shows: the conversation screen's input field, the card gallery, the demo shell, or
 * the demo's list of messages.
 */
const RENDERED = ['form input', '.gallery', '.demo-shell', '.i18n']

/**
 * Waits until one of RENDERED has rendered and the boot screen is gone, or, on a screen such as the demo's
 * /preview/screens/boot, until the boot screen is there.
 */
export async function waitForApp(client, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  // The boot screen fades out over the page for 0.4 s after the page is drawn, so a page counts as ready
  // only once the boot screen is gone; a capture taken earlier has the boot screen over it. The demo's
  // boot screens (/screens/boot…) are the one place where the boot screen is the page.
  const ready = `location.pathname.includes('/screens/boot')
    ? !!document.querySelector('.boot')
    : !!document.querySelector(${JSON.stringify(RENDERED.join(', '))}) && !document.querySelector('.boot')`
  // Checked every 50 ms: a screen of the demo is ready about 0.6 s after navigating, and polling every
  // 300 ms added up to a third of that to each load.
  // A page that throws while it starts, such as the demo refusing an unknown ?theme=, never renders. Its
  // error is reported once the page has had 3 s to render anyway, instead of a timeout 30 s later that
  // names no cause; an error on a page that does render is left to the page.
  // main.tsx catches an error thrown while the renderer starts and draws it with data-preload-failure on
  // <html>, so that page is reported at once with what it says. Just after a navigation commits, the new
  // document has no <html> yet and documentElement is null; reading it unguarded threw and stopped
  // demo:fit on CI (2026-09-26).
  const failed = `document.documentElement?.dataset.preloadFailure === 'true' ? document.body.innerText : null`
  while (Date.now() < deadline) {
    if (await client.evaluate(ready)) return
    const fatal = await client.evaluate(failed)
    if (fatal) throw new Error(`ページが起動に失敗しました: ${fatal.replace(/\s+/g, ' ').trim()}`)
    const first = client.navigation().exceptions[0]
    if (first && Date.now() - first.at > 3000) throw new Error(`ページが起動中に止まりました: ${first.text}`)
    await sleep(50)
  }
  // What the page shows when the time is up tells apart a document whose modules have not all loaded (its
  // readyState and an empty body), a page held on its boot screen (.boot without anything of RENDERED),
  // and a page the browser could not load (another URL, and the errors the browser logged).
  const shown = await client.evaluate(`({
    href: location.href,
    readyState: document.readyState,
    found: ${JSON.stringify([...RENDERED, '.boot'])}.filter((selector) => document.querySelector(selector)),
    text: (document.body?.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120)
  })`)
  const { url, at, logged } = client.navigation()
  throw new Error(
    [
      `${url} を開いて ${Math.round((Date.now() - at) / 1000)} 秒待っても、会話画面もカードの見本も起動画面も demo のフレームも表示されません`,
      `ページ: ${shown.href} (readyState: ${shown.readyState})`,
      `見つかった要素: ${shown.found.join(', ') || 'なし'}`,
      `本文: ${shown.text || '(なし)'}`,
      `ブラウザが記録したエラー: ${logged.length ? logged.slice(0, 5).join(' / ') : 'なし'}`
    ].join('\n  ')
  )
}

/** Measures the response state and the cards, which is what decides size, natural height and clipping. */
export const MEASURE_CARDS = `(() => {
  const dock = document.querySelector('.dock')
  const style = dock ? getComputedStyle(dock) : null
  const height = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null)
  return {
    window: [innerWidth, innerHeight],
    dockInner: dock ? dock.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) : null,
    phase: document.querySelector('.state-chip')?.textContent ?? null,
    cards: [...document.querySelectorAll('.panel-card')].map((card) => {
      const box = card.querySelector('.panel-body')
      const inner = card.querySelector('.panel-body-inner')
      return {
        type: card.dataset.panelType,
        size: card.dataset.size,
        card: height(card),
        natural: inner && box ? height(card) - box.clientHeight + inner.offsetHeight : null,
        clipped: box?.dataset.clipped ?? null,
        title: card.querySelector('h3')?.textContent ?? null
      }
    })
  }
})()`
export const measureCards = (client) => client.evaluate(MEASURE_CARDS)

/** The position and size of every element matching the selector, for breaking a layout down. */
export const rects = (client, selector) =>
  client.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
      text: (el.textContent ?? '').trim().replace(/\\s+/g, ' ').slice(0, 40) }
  })`)

export const click = (client, selector) =>
  client.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) throw new Error('要素がありません: ' + ${JSON.stringify(selector)})
    el.click()
    return true
  })()`)

export const pressKey = (client, key) =>
  client.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true })) || true`)

/**
 * Types an utterance and waits until the response has started and the app is back to IDLE. When cards are
 * expected, it also waits until there are at least minCards of them.
 */
export async function say(client, text, { minCards = 0, timeoutMs = 90_000 } = {}) {
  await client.evaluate(`(() => {
    const input = document.querySelector('form input')
    if (!input) throw new Error('入力欄がありません(会話画面を開いていますか)')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(text)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.form.requestSubmit()
    return true
  })()`)
  let started = false
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(500)
    const state = await measureCards(client)
    if (state.phase !== 'IDLE') started = true
    if (started && state.phase === 'IDLE' && state.cards.length >= minCards) return state
  }
  throw new Error(`応答が終わりません: ${text}`)
}
