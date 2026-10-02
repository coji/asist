#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { previewPath } from '../cdp.mjs'
import { main } from '../drive.mjs'
import { startDemo } from '../demo-server.mjs'

/**
 * The scene that writes the screenshots the README and the documentation show (npm run demo:docs-shots),
 * in Japanese and in English, in the simple theme, at a 1440x900 window captured at 2x.
 *
 * Usage: npm run demo:docs-shots -- [output directory]
 * Output: <output directory>/ja/<name>.webp and <output directory>/en/<name>.webp, by default under
 * website/public/screens. Only the interface language changes: the demo's sample data, such as events,
 * mails and memories, is written in Japanese and stays so in the English images.
 *
 * A button is found by the text of its dictionary key in the language the page shows (window.demoText in
 * src/renderer/src/demo/index.tsx), so the same steps run in both languages. A step that finds no button,
 * or a state that does not arrive in time, fails the run.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url))
const out = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? path.join(root, 'website/public/screens')

/** The folder of each language, the locale as UI_LOCALES spells it, and its name on the setup's language screen (UI_LOCALE_NAMES). */
const LANGUAGES = [
  { dir: 'ja', locale: 'ja-JP', name: '日本語' },
  { dir: 'en', locale: 'en-US', name: 'English' }
]
const THEME = 'simple'

/** The in-page text of a dictionary key; `values` fills its placeholders. */
const textOf = (key, values) => `window.demoText(${JSON.stringify(key)}, ${JSON.stringify(values ?? {})}).trim()`
/** The in-page text of a message written once per OS (`<key>.macos`, `<key>.windows`), for the OS the demo runs as. */
const osTextOf = (key, values) => `window.demoOsText(${JSON.stringify(key)}, ${JSON.stringify(values ?? {})}).trim()`

/** Presses the enabled button whose text includes the given in-page text. A missing button fails the run. */
const pressWhere = (text, label) => ({
  op: 'eval',
  value: `(() => { const text = ${text}; const b = [...document.querySelectorAll('button')].find((el) => el.textContent.includes(text) && !el.disabled); if (!b) throw new Error('押せるボタンがありません: ' + ${JSON.stringify(label)} + ' (' + text + ')'); b.click(); return text })()`
})
/** Presses the button labelled with a dictionary key. */
const press = (key, values) => pressWhere(textOf(key, values), key)
/** Presses the button that shows sample data, such as a job title, which is the same in every language. */
const pressData = (text) => pressWhere(JSON.stringify(text), text)
/** Presses the button labelled with a dictionary key when the screen shows one, and otherwise does nothing. */
const pressIfShown = (key) => ({
  op: 'eval',
  value: `(() => { const text = ${textOf(key)}; const b = [...document.querySelectorAll('button')].find((el) => el.textContent.includes(text) && !el.disabled); b?.click(); return !!b })()`
})
/**
 * Waits until the condition, an in-page expression, holds. Past the timeout the run fails with the label, and
 * so does a condition that throws, such as a key the dictionary does not hold: thrown inside the interval, it
 * would otherwise be dropped on every tick and the run would wait forever.
 */
const until = (condition, label, timeoutMs = 15_000) => ({
  op: 'eval',
  value: `new Promise((resolve, reject) => { const started = Date.now(); const timer = setInterval(() => { try { if (${condition}) { clearInterval(timer); resolve(${JSON.stringify(label)}) } else if (Date.now() - started > ${timeoutMs}) { clearInterval(timer); reject(new Error('現れません: ' + ${JSON.stringify(label)})) } } catch (error) { clearInterval(timer); reject(error) } }, 100) })`
})
/** Waits until the page shows the text of a dictionary key. */
const untilText = (key, values, timeoutMs) => until(`document.body.textContent.includes(${textOf(key, values)})`, key, timeoutMs)
/** Waits until the page shows the text of a message written once per OS. */
const untilOsText = (key, values, timeoutMs) => until(`document.body.textContent.includes(${osTextOf(key, values)})`, key, timeoutMs)
/** React tracks an input through its own setter, so the value goes in through the native setter and the event is dispatched afterwards. */
const type = (selector, text) => ({
  op: 'eval',
  value: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); return 'typed' })()`
})
const wait = (ms) => ({ op: 'wait', value: String(ms) })
/** Types into the input whose aria-label is the text of a dictionary key, through the native setter React listens to. */
const fill = (key, text) => ({
  op: 'eval',
  value: `(() => { const el = document.querySelector('input[aria-label="' + ${textOf(key)} + '"]'); if (!el) throw new Error('入力欄がありません: ' + ${JSON.stringify(key)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); return 'filled' })()`
})
/** Chooses an option of the select whose aria-label is the text of a dictionary key. */
const choose = (key, value) => ({
  op: 'eval',
  value: `(() => { const el = document.querySelector('select[aria-label="' + ${textOf(key)} + '"]'); if (!el) throw new Error('選択欄がありません: ' + ${JSON.stringify(key)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); return 'chosen' })()`
})
/** The sample mail account the documentation shows. The address and the password are not real. */
const MAIL_SAMPLE = {
  label: { 'ja-JP': '個人', en: 'Personal' },
  email: 'you@example.com',
  senderName: 'ASIST',
  password: 'abcd efgh ijkl mnop'
}
const shot = (name) => ({ op: 'shot', value: `${name}.webp` })
/** The setup is a dialog over a blurred screen, so only the dialog is kept, where its text stays readable. */
const setupShot = (name) => ({ op: 'shot', value: `${name}.webp`, clip: '.su-dialog' })
/** Ticks the box under the risks, which the next button waits for. */
const acknowledge = { op: 'eval', value: `(() => { document.querySelector('.su-ack input').click(); return 'ticked' })()` }

/** Steps for one language. Each image is taken once the step it shows is done, as a user sees it before going on. */
function steps({ locale, name }) {
  const view = (screen) => ({ op: 'goto', value: `${previewPath(`/screens/${screen}`)}?lang=${locale}&theme=${THEME}` })
  // The entrance animations of a screen and its cards settle within a second.
  const settle = wait(1500)
  // The label of the recommended option carries the name of the model, so the button is found by the rest of the label.
  const recommended = press('setup.listening.recommended', { model: '' })
  const passLanguage = [wait(1200), pressData(name), wait(400), press('setup.next'), wait(300), acknowledge, wait(200), press('setup.next'), wait(300)]
  const toMicrophone = [
    ...passLanguage,
    type('#su-key', 'demo-key-not-a-real-one'),
    press('setup.model.verifyAndSave'),
    untilText('setup.guide.model.verified'),
    press('setup.next'),
    wait(300),
    press('setup.speaking.voice.title'),
    press('setup.next'),
    wait(300),
    recommended,
    wait(200),
    press('setup.listening.prepareModel'),
    untilText('setup.guide.listening.ready'),
    press('setup.next'),
    wait(300),
    pressIfShown('setup.tts.verify'),
    pressIfShown('setup.tts.prepareModel'),
    untilText('setup.guide.tts.ready'),
    press('setup.next'),
    wait(300)
  ]
  return [
    { op: 'size', value: '1440x900' },

    view('conversation/cards'),
    until(`document.querySelectorAll('.panel-card').length >= 2`, 'two cards'),
    settle,
    shot('home'),
    view('calendar/event'),
    settle,
    shot('calendar'),
    view('jobs'),
    settle,
    pressData('README 英訳'),
    until(`!document.body.textContent.includes(${textOf('jobs.screen.emptyLog')})`, 'the job log'),
    wait(600),
    shot('agent'),
    view('memory'),
    settle,
    shot('memory'),
    view('mail/message'),
    settle,
    shot('mail'),

    // First-run setup, walked from start to finish in one page.
    view('setup'),
    wait(1200),
    pressData(name),
    wait(400),
    setupShot('setup-1-language'),
    press('setup.next'),
    wait(300),
    acknowledge,
    untilText('setup.guide.safety.done'),
    wait(300),
    setupShot('setup-safety'),
    press('setup.next'),
    wait(300),
    type('#su-key', 'demo-key-not-a-real-one'),
    press('setup.model.verifyAndSave'),
    untilText('setup.guide.model.verified'),
    wait(300),
    setupShot('setup-2-model'),
    press('setup.next'),
    wait(300),
    press('setup.speaking.voice.title'),
    wait(300),
    setupShot('setup-3-speaking'),
    press('setup.next'),
    wait(300),
    recommended,
    wait(200),
    press('setup.listening.prepareModel'),
    untilText('setup.guide.listening.ready'),
    wait(300),
    setupShot('setup-4-listening'),
    press('setup.next'),
    wait(300),
    // Choosing the language moved the setup to the engine that language starts on, a local one on the demo Mac,
    // whose model is prepared before it counts as ready.
    pressIfShown('setup.tts.verify'),
    pressIfShown('setup.tts.prepareModel'),
    untilText('setup.guide.tts.ready'),
    wait(300),
    setupShot('setup-5-speech'),
    press('setup.next'),
    wait(300),
    press('setup.mic.check'),
    untilText('setup.guide.mic.ready'),
    wait(300),
    setupShot('setup-6-microphone'),
    press('setup.next'),
    untilText('setup.guide.extras.done', undefined, 20_000),
    wait(300),
    setupShot('setup-7-extras'),
    press('setup.next'),
    wait(300),
    setupShot('setup-8-summary'),

    // The two failures the troubleshooting page shows.
    view('setup/key-failed'),
    ...passLanguage,
    setupShot('setup-key-failed'),
    view('setup/mic-denied'),
    ...toMicrophone,
    press('setup.mic.check'),
    untilOsText('setup.guide.mic.denied'),
    wait(300),
    setupShot('setup-mic-denied'),

    // Settings opens on its overview: the current setup, what still needs preparing, and what can be added.
    view('settings'),
    settle,
    shot('settings-overview'),
    ...['conversation', 'voice', 'language', 'appearance', 'agent'].flatMap((page) => [view(`settings/${page}`), settle, shot(`settings-${page}`)]),

    // Connecting Google Calendar: the calendar before the account is signed in, and after, with the calendars chosen.
    view('settings/connections/google-signed-out'),
    settle,
    { op: 'shot', value: 'calendar-sign-in.webp', clip: '.st-page > .st-group' },
    view('settings/connections'),
    settle,
    { op: 'shot', value: 'calendar-settings.webp', clip: '.st-page > .st-group' },

    // Adding a mail account: a Gmail account with a sample app password, after the connection is checked.
    view('settings/connections'),
    settle,
    press('settingsMail.add'),
    wait(400),
    choose('settingsMail.form.provider', 'gmail'),
    fill('settingsMail.form.label', MAIL_SAMPLE.label[locale] ?? MAIL_SAMPLE.label.en),
    fill('settingsMail.form.email', MAIL_SAMPLE.email),
    fill('settingsMail.form.senderName', MAIL_SAMPLE.senderName),
    fill('settingsMail.form.password', MAIL_SAMPLE.password),
    press('settingsMail.form.probe'),
    until(`document.querySelector('.ml-probe')`, 'the probe result'),
    { op: 'eval', value: `document.querySelector('.ml-account-form').scrollIntoView({ block: 'center' }), 'scrolled'` },
    wait(500),
    { op: 'shot', value: 'mail-add-account.webp', clip: '.ml-account-form' },

    // The other addresses the user sends from, opened on the first sample account, which lists one.
    view('settings/connections'),
    settle,
    press('settingsMail.account.otherAddresses'),
    until(`document.querySelector('.ml-account-form.is-other-addresses')`, 'the other addresses'),
    { op: 'eval', value: `document.querySelector('.ml-account-form.is-other-addresses').scrollIntoView({ block: 'center' }), 'scrolled'` },
    wait(500),
    { op: 'shot', value: 'mail-other-addresses.webp', clip: '.st-row:has(.ml-account-form.is-other-addresses)' }
  ]
}

const demo = await startDemo()
try {
  for (const language of LANGUAGES) {
    const report = await main(steps(language), { launch: true, demo, url: previewPath('/screens/conversation'), out: path.join(out, language.dir) })
    if (report.failed.length) break
  }
} finally {
  await demo.close()
}
console.log(`written: ${out}`)
// The demo this run served leaves the process alive after it is closed (demo-server.mjs).
process.exit()
