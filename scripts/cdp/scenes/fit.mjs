#!/usr/bin/env node
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { previewPath } from '../cdp.mjs'
import { run } from '../drive.mjs'
import { startDemo } from '../demo-server.mjs'

/**
 * The scene that tells whether the text still fits in every language of the interface (npm run demo:fit).
 *
 * Cards: every card sample at s, m, l and focus. It looks for a card taller than the height it was given,
 * text pushed past the edge of its card, and text cut short with an ellipsis or a hidden overflow. The
 * layout was tuned in Japanese and data such as a mail subject is cut short on purpose in every language,
 * so Japanese in the future theme is the baseline, and a language or theme reports only what that baseline
 * does not show at the same place.
 *
 * Screens: every screen of the demo. The controls (buttons, links, chips, tabs,
 * selects) are judged without a baseline, in Japanese too: one that wraps onto a second line, is cut
 * short, or reaches past the box that clips it is reported. Nothing had measured the screens before, so
 * Japanese is not assumed to be right there. A control that shows the user's data rather than a label,
 * such as an event block of the calendar, carries data-fit="data": its text is cut short on purpose, as
 * a mail subject is on a card, so it is skipped.
 *
 * Every check runs in every theme, since a theme may change the type of the headings. What a first pass
 * finds is measured again a second later and reported only if it is still there. The output is quiet when
 * everything fits; a finding is reported once, with every theme and language it appeared in, and captured
 * at 2x (fit-shots/ on CI, a temporary folder otherwise). On GitHub the findings also go to the run's summary.
 *
 * Usage: npm run demo:fit -- [--cards | --screens] [--theme name]... [--shard k/n] [locale]...
 *   Without a flag both are checked; without a locale, every language that can be chosen; without --theme,
 *   every theme. --shard k/n keeps every n-th of those themes from the k-th, so that n machines share the
 *   check; the baseline of the cards is measured in each.
 * Exit code 2 when there is a finding.
 */

const BASELINE = 'ja-JP'
const BASELINE_THEME = 'future'
const read = (file) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8')
const declared = [...read('src/shared/i18n/message.ts').match(/UI_LOCALES = \[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
const screens = [...read('src/renderer/src/demo/screens.ts').matchAll(/^\s+'?([\w/-]+)'?: \{ label:/gm)].map((match) => match[1])
const allThemes = [...read('src/shared/themes.ts').match(/THEMES = \[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
const args = process.argv.slice(2)
const themeArgs = args.flatMap((arg, i) => (arg === '--theme' ? [args[i + 1]] : []))
const unknownThemes = themeArgs.filter((theme) => !allThemes.includes(theme))
if (unknownThemes.length > 0) {
  console.error(`知らないテーマです: ${unknownThemes.join(', ')}。使えるのは ${allThemes.join(', ')} です`)
  process.exit(1)
}
const shardArg = args.includes('--shard') ? args[args.indexOf('--shard') + 1] : '1/1'
const [shard, shards] = (/^(\d+)\/(\d+)$/.exec(shardArg) ?? []).slice(1).map(Number)
if (!(shard >= 1 && shard <= shards)) {
  console.error(`--shard は 1/2 のように「何番目/いくつに分けるか」で書きます: ${shardArg}`)
  process.exit(1)
}
const themes = (themeArgs.length ? themeArgs : allThemes).filter((_, i) => i % shards === shard - 1)
const requested = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--theme' && args[i - 1] !== '--shard')
const unknown = requested.filter((locale) => !declared.includes(locale))
if (unknown.length > 0) {
  console.error(`知らないロケールです: ${unknown.join(', ')}。使えるのは ${declared.join(', ')} です`)
  process.exit(1)
}
const locales = requested.length ? requested : declared
const only = args.find((arg) => arg === '--cards' || arg === '--screens')

const MEASURE_CARDS = `(() => {
  const findings = []
  for (const card of document.querySelectorAll('.gallery-card')) {
    for (const dock of card.querySelectorAll('.dock[data-size], .gallery-column.is-focus')) {
      const size = dock.dataset.size ?? 'focus'
      const edge = (dock.querySelector('.panel-card') ?? dock).getBoundingClientRect()
      const at = (kind, element, text) => {
        const name = element.tagName.toLowerCase() + (element.classList[0] ? '.' + element.classList[0] : '')
        const index = [...dock.querySelectorAll(name)].indexOf(element)
        findings.push({ where: card.id + ' ' + size, kind, place: name + '#' + index, text: (text ?? element.textContent).trim().replace(/\\s+/g, ' ').slice(0, 70) })
      }
      const body = dock.querySelector('.panel-body[data-clipped="error"]')
      if (body) at('too tall', body, body.scrollHeight + 'px of content in ' + body.clientHeight + 'px')
      for (const element of dock.querySelectorAll('*')) {
        if (element.children.length > 0 && ![...element.children].every((child) => child.tagName === 'svg')) continue
        if (!element.textContent.trim()) continue
        const rect = element.getBoundingClientRect()
        if (rect.width === 0) continue
        if (rect.right > edge.right + 1 || rect.left < edge.left - 1) at('past the edge', element)
        else if (element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== 'visible') at('cut short', element)
      }
    }
  }
  return findings
})()`

const MEASURE_SCREEN = `(() => {
  const findings = []
  const controls = 'button, [role="button"], [role="tab"], a, select, summary, [class*="chip"], [class*="Chip"]'
  const seen = new Set()
  // A toast slides in from beyond the edge, so an element that is still moving is not where it will rest.
  const moving = document.getAnimations().map((animation) => animation.effect?.target).filter(Boolean)
  // A toast that has finished sliding out stays in the page, transparent and 30px to the right, until
  // AnimatePresence removes it, and by then no animation lists it; on CI's slower machine that moment was
  // measured as text past the edge (2026-09-24). What is fully transparent is not read, so it is not judged.
  const transparent = (element) => {
    for (let node = element; node; node = node.parentElement) if (getComputedStyle(node).opacity === '0') return true
    return false
  }
  for (const element of document.querySelectorAll(controls)) {
    if (moving.some((target) => target.contains(element)) || transparent(element)) continue
    if (element.closest('[data-fit="data"]')) continue
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden') continue
    const text = (element.tagName === 'SELECT' ? element.selectedOptions[0]?.textContent ?? '' : element.textContent).trim().replace(/\\s+/g, ' ')
    if (!text) continue
    // A control that holds other blocks, such as an option with a title and a description, is not one line of text.
    const simple = [...element.children].every((child) => child.tagName === 'svg' || getComputedStyle(child).display.startsWith('inline'))
    const name = element.tagName.toLowerCase() + (element.classList[0] ? '.' + element.classList[0] : '')
    const at = (kind) => {
      const key = kind + '|' + name + '|' + text
      if (seen.has(key)) return
      seen.add(key)
      findings.push({ kind, place: name, text: text.slice(0, 70) })
    }
    if (element.scrollWidth > element.clientWidth + 1 && style.overflowX !== 'visible') at('cut short')
    let clip = element.parentElement
    while (clip && getComputedStyle(clip).overflowX === 'visible') clip = clip.parentElement
    const box = clip ? clip.getBoundingClientRect() : { left: 0, right: innerWidth }
    if (rect.right > Math.min(box.right, innerWidth) + 1 || rect.left < Math.max(box.left, 0) - 1) at('past the edge')
    if (simple && element.tagName !== 'SELECT') {
      // Only the text is measured: an icon beside it sits on its own box, at another height.
      const tops = []
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        for (const r of range.getClientRects()) if (r.width > 1) tops.push(r.top)
      }
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4
      if (tops.length > 0 && Math.max(...tops) - Math.min(...tops) > lineHeight * 0.6) at('wraps')
    }
  }
  // Any other text that reaches past the box that clips it is lost to the reader, whatever it is.
  for (const element of document.querySelectorAll('body *')) {
    if (element.closest(controls) || element.children.length > 0 || !element.textContent.trim() || transparent(element)) continue
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0 || getComputedStyle(element).visibility === 'hidden') continue
    let clip = element.parentElement
    while (clip && getComputedStyle(clip).overflowX === 'visible') clip = clip.parentElement
    if (!clip) continue
    const box = clip.getBoundingClientRect()
    // A scrolling box shows the rest when scrolled, so only a box that hides its overflow loses text.
    if (getComputedStyle(clip).overflowX !== 'hidden' || box.width === 0) continue
    if (rect.right > box.right + 1 && element.scrollWidth <= element.clientWidth + 1) {
      const text = element.textContent.trim().replace(/\\s+/g, ' ').slice(0, 70)
      const name = element.tagName.toLowerCase() + (element.classList[0] ? '.' + element.classList[0] : '')
      const key = 'hidden|' + name + '|' + text
      if (!seen.has(key)) { seen.add(key); findings.push({ kind: 'hidden', place: name, text }) }
    }
  }
  return findings
})()`

const setLocale = (locale) => ({ op: 'eval', value: `window.demoSetUiLocale(${JSON.stringify(locale)})` })
const setTheme = (theme) => ({ op: 'eval', value: `window.demoSetTheme(${JSON.stringify(theme)})` })
/** Every theme and language to measure, each as "theme|locale". */
const pairs = (themeList, localeList) => themeList.flatMap((theme) => localeList.map((locale) => `${theme}|${locale}`))
/** The results of the measuring steps, in order; the other steps that evaluate code are left out. */
const measured = (report) =>
  report.steps.filter((step) => step.op === 'eval' && (step.value === MEASURE_SCREEN || step.value === MEASURE_CARDS)).map((step) => step.result)

/**
 * Resolves once the page has drawn twice with no animation running, or after 1.5 s. A spinner or the
 * orb loops for ever, so an animation without an end does not count. This replaced fixed waits of
 * 700 ms after a load and 200 ms after a change of language.
 */
const SETTLE = `new Promise((done) => {
  const start = performance.now()
  const check = () => requestAnimationFrame(() => requestAnimationFrame(() => {
    const running = document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity)
    if (!running || performance.now() - start > 1500) done(null)
    else setTimeout(check, 50)
  }))
  document.fonts.ready.then(check)
})`

/**
 * Each page is loaded once and the language is changed in place. Loading every screen again for every
 * language took 45 s a language; this way all eleven take about as long as one did.
 */
async function cards(all, wait = 300) {
  // A card reports that it is too tall 250 ms after its last change of size, so a short wait follows the settle.
  const steps = [{ op: 'size', value: '1720x900' }, { op: 'eval', value: LAYOUT_ONLY }, { op: 'eval', value: SETTLE }, { op: 'wait', value: '300' }]
  for (const pair of all) {
    const [theme, locale] = pair.split('|')
    steps.push(setTheme(theme), setLocale(locale), { op: 'eval', value: SETTLE }, { op: 'wait', value: String(wait) }, { op: 'eval', value: MEASURE_CARDS })
  }
  const report = await run(steps, { launch: true, demo, url: previewPath('/cards') })
  return new Map(measured(report).map((findings, index) => [all[index], findings]))
}

/**
 * Turns off what only paints, since every check here reads layout alone: animations and transitions end
 * at once, and the blur behind the glass panels and the canvases of the orb and the stars are not drawn.
 * Headless Chrome spent most of the run painting them.
 */
const LAYOUT_ONLY = `(() => {
  const style = document.createElement('style')
  style.textContent = '*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important } canvas { visibility: hidden !important }'
  document.head.append(style)
  return null
})()`

/**
 * The screens are split across this many Chromes that run at once. For the 42 screens in every theme and
 * language on a 10-core Mac (2026-10-02), 2 took 52 s, 3 about 38 s and 4 32 s. Three stay: each Chrome
 * holds about 1.1 GB, so four would hold about as much as the four Chromes that stalled on CI, while three
 * without the cards' Chrome are what opened a Chrome's eighth screen onwards there, about 4,000 screens on
 * 2026-10-02 without a stall.
 */
const WORKERS = 3

/** The three window sizes share one width and differ in height only, and none of these checks depends on the height. */
async function screensOf(all, screenList = screens, wait = 0) {
  const share = (list, n) => Array.from({ length: n }, (_, i) => list.filter((_, j) => j % n === i))
  const groups = share(screenList, WORKERS).filter((group) => group.length > 0)
  const byPair = new Map(all.map((pair) => [pair, []]))
  await Promise.all(
    groups.map(async (group) => {
      const steps = [{ op: 'size', value: 'l' }]
      for (const screen of group) {
        steps.push({ op: 'goto', value: previewPath(`/screens/${screen}`) }, { op: 'eval', value: LAYOUT_ONLY }, { op: 'eval', value: SETTLE })
        for (const pair of all) {
          const [theme, locale] = pair.split('|')
          steps.push(setTheme(theme), setLocale(locale), { op: 'eval', value: SETTLE })
          if (wait) steps.push({ op: 'wait', value: String(wait) })
          steps.push({ op: 'eval', value: MEASURE_SCREEN })
        }
      }
      const report = await run(steps, { launch: true, demo, url: previewPath('/screens/conversation') })
      measured(report).forEach((findings, index) => {
        const screen = group[Math.floor(index / all.length)]
        byPair.get(all[index % all.length]).push(...findings.map((finding) => ({ where: screen, ...finding })))
      })
    })
  )
  return byPair
}

// One demo serves every Chrome: a demo of its own for each would compile the modules again for each.
// The cards and the screens are measured one after the other, in Chromes of their own. Measured at once on
// CI, a screen was still loading its modules when the 30 s wait for it ended 18 times on 2026-10-02 and once
// on 10-01, each time at a Chrome's third to seventh screen and so while the cards' Chrome was running, and
// the wait overran its 30 s by 3 to 41 s in 15 of the 18, so Chrome or this process had stopped as a whole.
// The four Chromes and the demo held about 5.0 GB at once (physical footprint on a Mac, 2026-10-02), and
// CI's macOS runner has 7 GB, so memory pressure there is the likely cause, though it was not observed.
const demo = await startDemo()
const BASELINE_PAIR = `${BASELINE_THEME}|${BASELINE}`
const measuredPairs = pairs(themes, locales)
const comparedCardPairs = measuredPairs.filter((one) => one !== BASELINE_PAIR)
const unique = (list) => [...new Set(list)]
const cardKey = (finding) => `${finding.where}|${finding.kind}|${finding.place}`
const screenKey = (finding) => `${finding.where}|${finding.kind}|${finding.place}|${finding.text}`

const cardFirst = only === '--screens' ? null : await cards([BASELINE_PAIR, ...comparedCardPairs])
const screenFirst = only === '--cards' ? null : await screensOf(measuredPairs)
const candidates = []
if (cardFirst) {
  const baseline = new Set(cardFirst.get(BASELINE_PAIR).map(cardKey))
  for (const pair of comparedCardPairs) {
    for (const finding of cardFirst.get(pair)) if (!baseline.has(cardKey(finding))) candidates.push({ section: 'cards', pair, ...finding })
  }
}
if (screenFirst) {
  for (const pair of measuredPairs) for (const finding of screenFirst.get(pair)) candidates.push({ section: 'screens', pair, ...finding })
}

// What a first pass reports is measured once more, a second later, and only what is still there is
// reported. A layout that does not fit stays put; a moment of an animation does not, and one such moment
// once turned main red (a toast that had finished sliding out, 2026-09-24).
const cardAgain = unique(candidates.filter((c) => c.section === 'cards').map((c) => c.pair))
const screenAgain = candidates.filter((c) => c.section === 'screens')
const cardSecond = cardAgain.length ? await cards(cardAgain, 1000) : null
const screenSecond = screenAgain.length ? await screensOf(unique(screenAgain.map((c) => c.pair)), unique(screenAgain.map((c) => c.where)), 1000) : null
const stillThere = (c) =>
  c.section === 'cards'
    ? cardSecond.get(c.pair).some((finding) => cardKey(finding) === cardKey(c))
    : screenSecond.get(c.pair).some((finding) => screenKey(finding) === screenKey(c))
const confirmed = candidates.filter(stillThere)
const gone = candidates.length - confirmed.length

/**
 * One entry for each finding, with every theme and language it appeared in, since one layout fault usually
 * shows in several. A card's finding is one fault whatever its text, which is a height or a label that
 * differs by language, as the baseline compares them; a screen's is told apart by its text.
 */
const grouped = []
for (const finding of confirmed) {
  const key = `${finding.section}|${finding.section === 'cards' ? cardKey(finding) : screenKey(finding)}`
  const entry = grouped.find((one) => one.key === key)
  if (entry) {
    entry.pairs.push(finding.pair)
    if (!entry.texts.includes(finding.text)) entry.texts.push(finding.text)
  } else grouped.push({ key, ...finding, texts: [finding.text], pairs: [finding.pair] })
}
const textOf = (entry) => `"${entry.texts[0]}"${entry.texts.length > 1 ? ` and ${entry.texts.length - 1} other ${entry.texts.length === 2 ? 'text' : 'texts'}` : ''}`

// Each finding is captured at 2x in the first theme and language it appeared in. On CI the pictures go to
// fit-shots/, which the workflow keeps as an artifact of a failed run.
const onCi = process.env.GITHUB_ACTIONS === 'true'
let shotDir = null
if (grouped.length > 0) {
  shotDir = onCi ? path.resolve('fit-shots') : mkdtempSync(path.join(os.tmpdir(), 'asist-fit-'))
  mkdirSync(shotDir, { recursive: true })
  const steps = []
  for (const entry of grouped) {
    const [theme, locale] = entry.pairs[0].split('|')
    const query = `?theme=${theme}&lang=${locale}`
    const sample = entry.where.split(' ')[0]
    entry.shot = `${entry.section}-${entry.where.replace(/[^\w-]+/g, '-')}-${theme}-${locale}`
    if (entry.section === 'cards') {
      steps.push({ op: 'size', value: '1720x900' }, { op: 'goto', value: `${previewPath(`/cards/${sample}`)}${query}` }, { op: 'eval', value: SETTLE }, { op: 'fit', value: '.gallery' })
    } else {
      steps.push({ op: 'size', value: 'l' }, { op: 'goto', value: `${previewPath(`/screens/${entry.where}`)}${query}` }, { op: 'eval', value: SETTLE }, { op: 'wait', value: '500' })
    }
    steps.push({ op: 'shot', value: entry.shot })
  }
  await run(steps, { launch: true, demo, url: previewPath('/screens/conversation'), out: shotDir })
}

/** Where a finding appeared, theme by theme, and "every language" when it appeared in all that were measured. */
const whereIn = (list) =>
  themes
    .map((theme) => {
      const found = locales.filter((locale) => list.includes(`${theme}|${locale}`))
      if (found.length === 0) return null
      return `${theme}: ${found.length === locales.length && locales.length > 1 ? 'every language' : found.join(', ')}`
    })
    .filter(Boolean)
    .join('; ')
const lines = []
const scope = [
  `${themes.length} ${themes.length === 1 ? 'theme' : 'themes'} × ${locales.length} ${locales.length === 1 ? 'language' : 'languages'}`,
  ...(only === '--screens' ? [] : ['every card sample at s/m/l/focus']),
  ...(only === '--cards' ? [] : [`${screens.length} screens`])
]
lines.push(`demo:fit  ${scope.join(' · ')}`)
for (const [section, compared] of [['cards', comparedCardPairs.length], ['screens', measuredPairs.length]]) {
  if (section === 'cards' ? !cardFirst : !screenFirst) continue
  const entries = grouped.filter((entry) => entry.section === section)
  if (entries.length === 0) {
    lines.push(`${section.padEnd(8)} everything fits in ${compared} combinations`)
    continue
  }
  const affected = unique(entries.flatMap((entry) => entry.pairs)).length
  lines.push(`${section.padEnd(8)} ${entries.length} to look at, in ${affected} of ${compared} combinations`)
  for (const entry of entries) {
    lines.push('', `  ${entry.where}  ${entry.kind}  ${entry.place}`, `    ${textOf(entry)}`, `    in ${whereIn(entry.pairs)}`, `    shot: ${onCi ? `fit-shots/${entry.shot}.png` : path.join(shotDir, `${entry.shot}.png`)}`)
  }
  lines.push('')
}
if (gone > 0) lines.push(`(${gone} ${gone === 1 ? 'finding was' : 'findings were'} gone when measured again and ${gone === 1 ? 'is' : 'are'} not reported)`)
if (shotDir) lines.push(onCi ? 'screenshots: the fit-shots artifact of this run' : `screenshots: ${shotDir}`)
console.log(lines.join('\n'))

// On GitHub the same findings go to the run's summary page, so they can be read without opening the log.
if (process.env.GITHUB_STEP_SUMMARY) {
  const cell = (text) => String(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
  const summary = ['### demo:fit', '', lines[0].replace('demo:fit  ', ''), '']
  if (grouped.length === 0) summary.push('Everything fits.')
  else {
    summary.push('| where | what | element | text | in |', '| --- | --- | --- | --- | --- |')
    for (const entry of grouped) summary.push(`| ${cell(entry.where)} | ${entry.kind} | ${cell(entry.place)} | ${cell(textOf(entry))} | ${whereIn(entry.pairs)} |`)
    summary.push('', 'The screenshots are in the fit-shots artifact of this run.')
  }
  if (gone > 0) summary.push('', `${gone} ${gone === 1 ? 'finding was' : 'findings were'} gone when measured again and ${gone === 1 ? 'is' : 'are'} not reported.`)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`)
}

if (grouped.length > 0) process.exitCode = 2
// The demo this run served leaves the process alive after it is closed (demo-server.mjs).
process.exit()
