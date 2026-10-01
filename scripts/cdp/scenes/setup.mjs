#!/usr/bin/env node
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { previewPath } from '../cdp.mjs'
import { main } from '../drive.mjs'

/**
 * The scene that walks the first-run setup from start to finish and captures every screen
 * (npm run demo:setup).
 *
 * Usage: npm run demo:setup -- [output directory]
 * Output: setup-01-….png and onwards. The branches, which are a key that fails verification, a denied
 * microphone, the text-only path and a language other than the one the setup opens on, are captured last.
 * The demo's mock advances the state as the steps run, so no key is really verified, no model is really
 * downloaded and no microphone permission is really requested.
 */

const out = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? (await mkdtemp(path.join(os.tmpdir(), 'asist-setup-')))
const view = (name) => previewPath(`/screens/${name}`)

/** Buttons have no id, so one is found by its label and pressed. A missing button fails the run. */
const press = (text) => ({
  op: 'eval',
  value: `(() => { const b = [...document.querySelectorAll('button')].find((el) => el.textContent.includes(${JSON.stringify(text)}) && !el.disabled); if (!b) throw new Error(${JSON.stringify(`押せるボタンがありません: ${text}`)}); b.click(); return ${JSON.stringify(text)} })()`
})
/** React tracks an input through its own setter, so the value goes in through the native setter and the event is dispatched afterwards. */
const type = (selector, text) => ({
  op: 'eval',
  value: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); return 'typed' })()`
})
const wait = (ms) => ({ op: 'wait', value: String(ms) })
const shot = (name) => ({ op: 'shot', value: name })
/** Ticks the box under the risks, which the next button waits for. */
const acknowledge = { op: 'eval', value: `(() => { document.querySelector('.su-ack input').click(); return 'ticked' })()` }

/**
 * Gets past the language screen, which opens on the language of the system, past the risks, and then
 * past the model screen, leaving the provider as it is and verifying a sample key.
 */
const passModel = [wait(1000), press('次へ'), wait(300), acknowledge, wait(200), press('次へ'), wait(300), type('#su-key', 'demo-key-not-a-real-one'), press('検証して保存'), wait(1300), press('次へ'), wait(300)]

await main(
  [
    { op: 'size', value: '1440x900' },
    // 1. Language.
    wait(1200),
    shot('setup-01-language'),
    press('次へ'),
    // 1b. The risks, which wait for the box to be ticked.
    wait(300),
    shot('setup-01b-safety'),
    acknowledge,
    wait(200),
    shot('setup-01c-safety-acknowledged'),
    press('次へ'),
    // 2. Model.
    wait(300),
    shot('setup-02-model-empty'),
    { op: 'click', value: '.su-provider[data-provider="openai"]' },
    wait(200),
    shot('setup-03-model-openai'),
    type('#su-key', 'demo-key-not-a-real-one'),
    shot('setup-04-model-typed'),
    press('検証して保存'),
    wait(200),
    shot('setup-05-model-verifying'),
    wait(1300),
    shot('setup-06-model-verified'),
    press('次へ'),
    // 3. How to speak.
    wait(300),
    shot('setup-07-speaking-unselected'),
    press('声で話す'),
    wait(200),
    shot('setup-08-speaking-voice'),
    press('次へ'),
    // 4. Listening.
    wait(300),
    shot('setup-09-listening-unselected'),
    press('おすすめ'),
    wait(200),
    shot('setup-10-listening-server'),
    press('モデルを準備する'),
    wait(1500),
    shot('setup-11-listening-preparing'),
    wait(4500),
    shot('setup-12-listening-ready'),
    press('ブラウザ内の Whisper'),
    wait(200),
    press('モデルを準備する'),
    wait(1200),
    shot('setup-13-listening-local-preparing'),
    wait(2500),
    shot('setup-14-listening-local-ready'),
    press('おすすめ'),
    wait(200),
    press('次へ'),
    // 5. Speech. A Japanese conversation starts on Irodori-TTS on the demo Mac.
    wait(300),
    shot('setup-15-tts-unready'),
    press('モデルを準備する'),
    wait(1500),
    shot('setup-15b-tts-irodori-preparing'),
    wait(3000),
    shot('setup-15c-tts-irodori-ready'),
    press('VOICEVOX'),
    wait(300),
    press('検証する'),
    wait(300),
    shot('setup-16-tts-verifying'),
    wait(1600),
    shot('setup-17-tts-voicevox-ready'),
    press('Qwen3-TTS'),
    wait(300),
    press('モデルを準備する'),
    wait(1500),
    shot('setup-17b-tts-qwen-preparing'),
    wait(3000),
    press('macOS の音声合成'),
    wait(600),
    shot('setup-18-tts-system'),
    press('次へ'),
    // 6. Microphone.
    wait(300),
    shot('setup-19-mic-unchecked'),
    press('マイクを検証する'),
    wait(200),
    shot('setup-20-mic-checking'),
    wait(1500),
    shot('setup-21-mic-granted'),
    press('次へ'),
    // 7. The remaining preparation, which starts on its own on arrival.
    wait(1200),
    shot('setup-22-extras-preparing'),
    wait(7500),
    shot('setup-23-extras-ready'),
    press('次へ'),
    // 8. Confirmation.
    wait(300),
    shot('setup-24-summary'),
    press('この内容で始める'),
    wait(1500),
    shot('setup-25-finished'),

    // Branch: the saved key could not be verified.
    { op: 'goto', value: view('setup/key-failed') },
    wait(1200),
    shot('setup-30-model-key-failed'),

    // Branch: text only, which skips listening, speech and the microphone.
    { op: 'goto', value: view('setup') },
    ...passModel,
    press('文字だけで使う'),
    wait(200),
    shot('setup-31-speaking-text-only'),
    press('次へ'),
    wait(3000),
    shot('setup-32-extras-text-only'),
    press('次へ'),
    wait(300),
    shot('setup-33-summary-text-only'),

    // Branch: the speech app is not installed, so verifying it fails.
    { op: 'goto', value: view('setup/tts-missing') },
    ...passModel,
    press('文字で打ち'),
    press('次へ'),
    wait(300),
    press('検証する'),
    wait(2000),
    shot('setup-34-tts-missing'),

    // Branch: the microphone is denied.
    { op: 'goto', value: view('setup/mic-denied') },
    ...passModel,
    press('声で話す'),
    press('次へ'),
    wait(300),
    press('おすすめ'),
    press('モデルを準備する'),
    wait(5500),
    press('次へ'),
    wait(300),
    press('macOS の音声合成'),
    wait(600),
    press('次へ'),
    wait(300),
    press('マイクを検証する'),
    wait(1200),
    shot('setup-35-mic-denied'),

    // Branch: another language, which the rest of the setup is then shown in.
    { op: 'goto', value: view('setup') },
    wait(1200),
    press('English'),
    wait(400),
    shot('setup-36-language-english'),
    press('Next'),
    wait(300),
    shot('setup-37-safety-english'),
    acknowledge,
    wait(200),
    press('Next'),
    wait(300),
    shot('setup-38-model-english')
  ],
  { launch: true, url: view('setup'), out }
)
console.log(`written: ${out}`)
// The demo this run served leaves the process alive after it is closed (demo-server.mjs).
process.exit()
