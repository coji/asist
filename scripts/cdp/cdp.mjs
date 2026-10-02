import { existsSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
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

/**
 * Starts headless Chrome with a CDP port and a profile of its own in the temporary folder, and returns the
 * port and close(), which stops Chrome and removes the profile once Chrome has exited. Port 0 picks a free one.
 * `args` are flags added to the usual ones.
 */
export async function launchChrome({ port = 0, url = 'about:blank', args = [] } = {}) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'asist-chrome-'))
  const child = spawn(chromePath(), [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    ...args,
    url
  ])
  const exited = new Promise((resolve) => child.once('exit', resolve))
  // Chrome and its profile are never left behind, however this process ends. A handler of the exit cannot
  // wait for Chrome to end, so it kills Chrome outright and removes the profile at once.
  const leave = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    rmSync(profile, { recursive: true, force: true })
  }
  process.on('exit', leave)
  const close = async () => {
    child.kill()
    await exited
    // Chrome's helper processes can still write into the profile for a moment after the browser has exited: on a
    // CI runner the removal met a folder filled again while it was emptied (ENOTEMPTY, 2026-10-02). rm retries
    // such a folder, waiting a little longer each time.
    await rm(profile, { recursive: true, force: true, maxRetries: 5 })
    process.off('exit', leave)
  }
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let buffer = ''
      child.stderr.on('data', (chunk) => {
        buffer += chunk
        const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/)
        if (match) resolve(match[1])
      })
      child.on('exit', (code) => reject(new Error(`Chrome が終了しました: ${code}`)))
    })
    return { port: Number(new URL(wsUrl).port), close }
  } catch (error) {
    await close()
    throw error
  }
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
  const { send, onEvent, close } = await openSocket(page.webSocketDebuggerUrl)
  /**
   * The last navigation, or the page as it was when connected: its URL, when it began, and since then the
   * uncaught errors of the page and the errors the browser logged, such as a module it could not load.
   * waitForApp reports them when the page never renders.
   */
  let navigation = { url: page.url, at: Date.now(), exceptions: [], logged: [] }
  onEvent((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const details = msg.params.exceptionDetails
      navigation.exceptions.push({ at: Date.now(), text: details.exception?.description ?? details.text })
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      const { text, url } = msg.params.entry
      navigation.logged.push(url ? `${text} ${url}` : text)
    }
  })
  await send('Runtime.enable')
  await send('Log.enable')
  return {
    send,
    onEvent,
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
    close
  }
}

/**
 * Connects to the browser itself rather than to a page, for what only the browser answers, such as the
 * processes it runs (SystemInfo.getProcessInfo) and the targets it holds. A command for a target the browser
 * session attached to with `flatten: true` carries that target's session id as the third argument of send.
 */
export async function connectBrowser(port) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  return openSocket(webSocketDebuggerUrl)
}

/** Opens a CDP WebSocket and returns how to send a command on it and how to hear its events. */
async function openSocket(url) {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('CDP に接続できません')))
  })
  let seq = 0
  const pending = new Map()
  const listeners = new Set()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    } else if (msg.method) {
      for (const listener of listeners) listener(msg)
    }
  })
  return {
    send: (method, params = {}, sessionId = undefined) =>
      new Promise((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params, sessionId }))
      }),
    /** Calls the listener with every event, until the function it returns is called. */
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
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
 * The phases of the state chip in which the app is not answering. It rests on IDLE, and on LISTENING once
 * the live engine, which holds the microphone, has opened its session.
 */
const RESTING_PHASES = new Set(['IDLE', 'LISTENING'])
/**
 * How long the app has to rest before a response counts as over, because either engine can rest in the
 * middle of one: between two sentences, or while a function runs after a sentence. Asked by typing for the
 * weather of one place and of two places on 2026-10-02, Gemini Live showed LISTENING for up to 1.9 s before
 * it spoke, from the moment its session opened, and for 0.5 s between two parts of its speech.
 */
const RESPONSE_SETTLE_MS = 3000
const POLL_MS = 200

/** Remembers the toasts on screen, so that NEW_ERROR_TOAST reports only one that appears afterwards. */
const MARK_TOASTS = `window.__driveSeenToasts = new WeakSet(document.querySelectorAll('[data-toast]'))`
/**
 * The text of an error toast that appeared since MARK_TOASTS, or null. A page loaded since then has lost
 * what MARK_TOASTS remembered, and the response or the microphone being waited for with it.
 */
const NEW_ERROR_TOAST = `(() => {
  const seen = window.__driveSeenToasts
  if (!seen) throw new Error('待っている間にページが読み込み直されました')
  const toast = [...document.querySelectorAll('[data-toast="error"]')].find((el) => !seen.has(el))
  return toast ? toast.innerText.replace(/\\s+/g, ' ').trim() : null
})()`

function throwIfShown(error) {
  if (error) throw new Error(`アプリがエラーを表示しました: ${error}`)
}

/** What say() polls while it waits. The cards are measured once, when the response is over. */
const RESPONSE_STATE = `({
  phase: document.querySelector('.state-chip')?.textContent ?? null,
  cards: document.querySelectorAll('.panel-card').length,
  error: ${NEW_ERROR_TOAST}
})`

/**
 * Types an utterance and waits until the response is over: the app has answered, by thinking or speaking,
 * and has then rested for RESPONSE_SETTLE_MS. When cards are expected, it also waits until there are at
 * least minCards of them. An error the app shows meanwhile, such as the live engine refusing text while the
 * microphone is off, fails it at once with the app's words.
 */
export async function say(client, text, { minCards = 0, timeoutMs = 90_000 } = {}) {
  await client.evaluate(`(() => {
    const input = document.querySelector('form input')
    if (!input) throw new Error('入力欄がありません(会話画面を開いていますか)')
    ${MARK_TOASTS}
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(text)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.form.requestSubmit()
    return true
  })()`)
  let started = false
  let restingSince = null
  let state = null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(POLL_MS)
    state = await client.evaluate(RESPONSE_STATE)
    throwIfShown(state.error)
    if (!RESTING_PHASES.has(state.phase)) {
      started = true
      restingSince = null
      continue
    }
    restingSince ??= Date.now()
    if (started && Date.now() - restingSince >= RESPONSE_SETTLE_MS && state.cards >= minCards) return measureCards(client)
  }
  throw new Error(
    started
      ? `応答が終わりません(最後の状態 ${state.phase}、カード ${state.cards} 枚): ${text}`
      : `応答が始まりません(状態 ${state?.phase}): ${text}`
  )
}

/** Whether the microphone button shows on, loading or off, or null when the screen has no such button. */
const MIC_STATE = `(() => {
  const button = document.querySelector('button.mic')
  if (!button) return null
  return button.classList.contains('is-on') ? 'on' : button.classList.contains('is-loading') ? 'loading' : 'off'
})()`

/**
 * Turns the app's microphone on or off with its button, unless it already is, and waits until it is. On,
 * the app hears the room and answers it, and the live engine sends it to the provider; it is also what lets
 * the live engine take typed text. A failure the app shows, such as a denied permission, fails it at once.
 */
export async function setMic(client, wanted, { timeoutMs = 60_000 } = {}) {
  const current = await client.evaluate(MIC_STATE)
  if (current === null) throw new Error('マイクのボタンがありません(会話画面を開いていますか)')
  if (current === wanted) return
  await client.evaluate(MARK_TOASTS)
  // A microphone that is loading is already on its way on, and a click would turn it off.
  if (current !== 'loading' || wanted === 'off') await click(client, 'button.mic')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(POLL_MS)
    const { mic, error } = await client.evaluate(`({ mic: ${MIC_STATE}, error: ${NEW_ERROR_TOAST} })`)
    throwIfShown(error)
    if (mic === wanted) return
  }
  throw new Error(`マイクが ${wanted} になりません`)
}
