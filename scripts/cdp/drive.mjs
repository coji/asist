#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  click,
  connect,
  APP_PATH,
  launchChrome,
  measureCards,
  pressKey,
  rects,
  say,
  setMic,
  sleep,
  waitForApp,
  WINDOWS,
  windowSize
} from './cdp.mjs'
import { startDemo } from './demo-server.mjs'

/**
 * The general-purpose driver (npm run demo:drive). It drives a screen over CDP, running the steps in the
 * order they are written and measuring as it goes.
 *
 * What it connects to:
 *   --launch         serves this checkout's demo and opens a headless Chrome on it, both on ports the OS
 *                    picks, and closes both at the end (--url, a path such as /preview/cards, changes the
 *                    page it opens first)
 *   --port <port>    the headless Chrome that npm run demo:open left open, whose port it printed
 *   --port 9222      ASIST itself, started with --remote-debugging-port=9222
 *
 * The steps, run in the order they are given:
 *   --say text          types an utterance and waits for the response to finish (against the app, this
 *                       uses the real APIs)
 *   --mic on|off        turns the app's microphone on or off and waits until it is; the live engine takes
 *                       typed text only while it is on, and on, the app also answers the sound of the room
 *   --click selector    clicks the element
 *   --key name          presses a key, such as Escape
 *   --goto path|url     navigates and waits for the conversation screen; a path resolves against the
 *                       demo the run is on
 *   --size l|m|s|WxH    pretends the window has that size (for the demo, never for the app's window)
 *   --fit selector      grows the window to the content height of that element, so that a tall page fits
 *                       in one capture (for the demo)
 *   --wait ms           waits
 *   --eval expression   evaluates JS and records the result
 *   --rect selector     records the position and size of the matching elements
 *   --cards             records each card's size, natural height and clipping
 *   --shot name         writes <name>.png under --out, or a WebP when the name ends in .webp
 *                       (a scene's shot step may also carry clip: selector, which keeps only that element)
 *
 * The result is JSON. A --cards step exits with code 2 when a card does not fit, or when a card's size
 * does not match the preceding --size.
 * For example: node scripts/cdp/drive.mjs --launch --goto /preview/cards/fx --size s --cards --rect '.fx-hero' --out /tmp/x --shot s
 */

const STEP_OPS = new Set(['say', 'mic', 'click', 'key', 'goto', 'size', 'fit', 'wait', 'eval', 'rect', 'cards', 'shot'])
/**
 * The quality of a --shot written as WebP, which Chrome encodes itself so that no image library is needed.
 * At 85 the text keeps sharp edges, and the largest 1440x900 screen captured at 2x by demo:docs-shots
 * came to 309 KB (measured 2026-09-25).
 */
const WEBP_QUALITY = 85
/** The margin a clipped --shot keeps around its element, in CSS px, so that its shadow is not cut. */
const CLIP_MARGIN = 24
/** The tallest a single capture may be, in px. Captures are at 2x, so the image is twice this. */
const FIT_MAX_HEIGHT = 12_000
const FLAGS = new Set(['launch'])
const OPTIONS = new Set(['port', 'url', 'out', 'name'])

/** Splits the arguments into the steps, whose order is kept, and the options such as what to connect to. */
export function parse(argv) {
  const steps = []
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`不明な引数: ${arg}`)
    const name = arg.slice(2)
    if (FLAGS.has(name)) {
      options[name] = true
    } else if (OPTIONS.has(name)) {
      options[name] = argv[++i]
    } else if (name === 'cards') {
      steps.push({ op: name })
    } else if (STEP_OPS.has(name)) {
      const value = argv[++i]
      if (value === undefined) throw new Error(`--${name} に値がありません`)
      if (name === 'mic' && value !== 'on' && value !== 'off') throw new Error(`--mic は on か off です: ${value}`)
      steps.push({ op: name, value })
    } else {
      throw new Error(`不明な引数: --${name}`)
    }
  }
  return { steps, options }
}

/**
 * Runs the steps and returns the result. With `launch` it serves this checkout's demo and opens its own
 * Chrome, and closes both at the end. A scene that runs several at once passes the demo it started as
 * `demo`, which the run uses and leaves open. The returned `failed` holds the index of each step where a card did
 * not fit.
 */
export async function run(steps, options = {}) {
  let demo = null
  let chrome = null
  let client
  let origin
  if (options.launch) {
    if (!options.demo) demo = await startDemo()
    origin = (options.demo ?? demo).origin
    chrome = await launchChrome()
    client = await connect(chrome.port)
    await client.resize(WINDOWS.l)
    await client.navigate(new URL(options.url ?? APP_PATH, origin).href)
    await waitForApp(client)
  } else {
    if (!options.port) throw new Error('--launch か --port <番号> を指定します')
    client = await connect(Number(options.port))
    origin = await client.evaluate('location.origin')
  }
  const results = []
  const failed = []
  let sizeName = null
  let window = WINDOWS.l
  let saidCount = 0
  try {
    if (options.out) await mkdir(options.out, { recursive: true })
    for (const step of steps) {
      const result = { op: step.op, value: step.value }
      switch (step.op) {
        case 'say':
          saidCount += 1
          await say(client, step.value, { minCards: 0 })
          await sleep(1200)
          break
        case 'mic':
          await setMic(client, step.value)
          break
        case 'click':
          await click(client, step.value)
          await sleep(400)
          break
        case 'key':
          await pressKey(client, step.value)
          await sleep(300)
          break
        case 'goto':
          await client.navigate(new URL(step.value, origin).href)
          await waitForApp(client)
          break
        case 'size':
          sizeName = WINDOWS[step.value] ? step.value : null
          window = windowSize(step.value)
          await client.resize(window)
          await sleep(1200)
          break
        case 'fit': {
          const height = await client.evaluate(
            `Math.ceil((document.querySelector(${JSON.stringify(step.value)}) ?? document.documentElement).scrollHeight)`
          )
          window = [window[0], Math.min(FIT_MAX_HEIGHT, Math.max(400, height))]
          result.result = { height: window[1] }
          await client.resize(window)
          await sleep(800)
          break
        }
        case 'wait':
          await sleep(Number(step.value))
          break
        case 'eval':
          result.result = await client.evaluate(step.value)
          break
        case 'rect':
          result.result = await rects(client, step.value)
          break
        case 'cards': {
          const measured = await measureCards(client)
          result.size = sizeName
          result.result = measured
          if (measured.cards.some((c) => c.clipped === 'error' || (sizeName && c.size !== sizeName))) {
            failed.push(results.length)
          }
          break
        }
        case 'shot': {
          if (!options.out) throw new Error('--shot には --out が要ります')
          const prefix = options.name ? `${options.name}-` : ''
          const webp = step.value.endsWith('.webp')
          const file = path.join(options.out, `${prefix}${step.value}${webp ? '' : '.png'}`)
          const clip = step.clip ? await clipAround(client, step.clip) : undefined
          await writeFile(file, await client.screenshot({ ...(webp ? { webpQuality: WEBP_QUALITY } : {}), clip }))
          result.file = file
          break
        }
      }
      results.push(result)
    }
  } finally {
    client.close()
    chrome?.child.kill()
    await demo?.close()
  }
  return { url: options.launch ? origin : `cdp:${options.port}`, said: saidCount, steps: results, failed }
}

/** The shared exit, which the scenes use too: print the JSON and exit with code 2 when something does not fit. */
export async function main(steps, options) {
  const report = await run(steps, options)
  console.log(JSON.stringify(report, null, 2))
  if (report.failed.length) {
    console.error(`収まっていないカードか、サイズの合わないカードがあります(手順 ${report.failed.join(', ')})`)
    process.exitCode = 2
  }
  return report
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { steps, options } = parse(process.argv.slice(2))
  if (steps.length === 0) steps.push({ op: 'cards' })
  await main(steps, options)
  // The demo this run served leaves the process alive after it is closed (demo-server.mjs).
  process.exit()
}

/** The rectangle of the element, widened by CLIP_MARGIN and kept inside the window. A missing element fails the step. */
async function clipAround(client, selector) {
  const rect = await client.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) throw new Error('要素がありません: ' + ${JSON.stringify(selector)})
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height, innerWidth, innerHeight }
  })()`)
  const x = Math.max(0, rect.x - CLIP_MARGIN)
  const y = Math.max(0, rect.y - CLIP_MARGIN)
  return {
    x,
    y,
    width: Math.min(rect.innerWidth, rect.x + rect.width + CLIP_MARGIN) - x,
    height: Math.min(rect.innerHeight, rect.y + rect.height + CLIP_MARGIN) - y
  }
}
