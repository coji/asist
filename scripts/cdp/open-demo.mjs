#!/usr/bin/env node
import { APP_PATH, connect, launchChrome, say, sleep, waitForApp, WINDOWS, windowSize } from './cdp.mjs'
import { startDemo } from './demo-server.mjs'

/**
 * Serves this checkout's demo and opens it in headless Chrome, both on ports the OS picks, and keeps them
 * open (npm run demo:open). While they stay open, drive.mjs --port <the printed port> can drive and measure
 * the page as often as needed, and Vite's HMR carries every edit into it, which is what makes iterating on
 * CSS quick. Ctrl-C or SIGTERM closes both.
 *
 * Usage: npm run demo:open -- [--port <CDP port>] [--url /preview/cards/fx] [--size l|m|s|WxH] [--say text]...
 */

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
const port = Number(option('port', 0))
const path = option('url', APP_PATH)
const size = windowSize(option('size', 'l'))
const sayings = argv.flatMap((a, i) => (a === '--say' ? [argv[i + 1]] : []))

const demo = await startDemo()
const url = new URL(path, demo.origin).href
const chrome = await launchChrome({ port })
const stop = () => {
  // Wait for Chrome to exit and its profile to go before leaving; if that takes too long, the handler
  // launchChrome set on the exit kills Chrome and removes the profile.
  void chrome.close().then(() => process.exit(0))
  void demo.close()
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
try {
  const client = await connect(chrome.port)
  await client.resize(size)
  await client.navigate(url)
  await waitForApp(client)
  for (const [i, text] of sayings.entries()) {
    await say(client, text, { minCards: Math.min(2, i + 1) })
    await sleep(1000)
  }
  client.close()
  console.log(`ready: port ${chrome.port} ${size.join('x')} ${url}`)
  console.log(`next: npm run demo:drive -- --port ${chrome.port} --cards  (sizes: ${Object.keys(WINDOWS).join('/')})`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  await chrome.close()
  process.exit(1)
}
await new Promise(() => {})
