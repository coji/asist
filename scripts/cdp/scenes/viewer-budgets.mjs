#!/usr/bin/env node
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connect, launchChrome, previewPath, sleep, waitForApp } from '../cdp.mjs'
import { SERVED_FILES_PATH, startDemo } from '../demo-server.mjs'
import { measureFile } from '../viewer-measure.mjs'
import { prepareFiles, VIEWER_FILES } from '../viewer-files/index.mjs'

/**
 * The scene that holds the viewers of the files card to their budgets (npm run demo:viewer-budgets). It writes
 * large files of each kind into a folder (viewer-files/), serves them from the demo, and measures each case's file
 * in the card and its focus view, one Chrome at a time (viewer-measure.mjs). A case is over its budget when a
 * measured value is not within the budget's, and fails when its viewer shows an error, a placard or a note that
 * leaves the content out, when a screen of the focus view is never shown, or when a frame crashes; the run then
 * exits with code 2. The memory is read with ps, so the scene stops with an error on Windows.
 *
 * The cases live one file per viewer in viewer-budgets/, each exporting `cases`, so that a change to one viewer
 * adds or edits only its own file:
 *
 *   export const cases = [{
 *     name: 'pdf-1000',            // unique among all cases
 *     file: 'pdf-1000',            // a key of VIEWER_FILES
 *     budget: { cardFirstMs, cardHeldMs, completeMs, cardPeakMb, focusFirstMs, focusHeldMs, slowestScreenMs,
 *               peakMb, finalMb, gpuPeakMb }, // any of them
 *     shown: (root, mode) => …,    // optional: when the content in view is drawn
 *     complete: (root) => …        // optional: when the card has finished, such as a whole waveform
 *   }]
 *
 * `shown` and `complete` are sent to the page as their source and run there at every frame with the card's or
 * the focus view's element, so they use nothing from outside their own body. Without `shown`, viewer-measure.mjs's
 * contentShown decides, which never takes a placard or a note for content.
 *
 * Usage: npm run demo:viewer-budgets -- [--case name]... [--measure file|all]... [--files folder] [--time-factor n] [--out folder]
 *   --case          runs only the cases named
 *   --measure       measures files of VIEWER_FILES with no budget, for numbers to set a budget from
 *   --files         keeps the generated files in this folder and reuses them on the next run; without it they
 *                   are written to a temporary folder and removed at the end
 *   --time-factor   multiplies every time budget, for a slower machine (CI passes 3); memory budgets stay as written
 *   --out           also writes the results as viewer-budgets.json there
 */

const args = process.argv.slice(2)
const values = (name) => args.flatMap((arg, i) => (arg === `--${name}` ? [args[i + 1]] : []))
const single = (name) => values(name).at(-1)
const timeFactor = Number(single('time-factor') ?? 1)
if (!(timeFactor >= 1)) throw new Error(`--time-factor は 1 以上の数です: ${single('time-factor')}`)

const BUDGETS = {
  cardFirstMs: { read: (r) => r.card.firstMs, time: true },
  cardHeldMs: { read: (r) => r.card.heldMs, time: true },
  completeMs: { read: (r) => r.card.completeMs, time: true },
  cardPeakMb: { read: (r) => r.memory.cardPeakMb, time: false },
  focusFirstMs: { read: (r) => r.focus.firstMs, time: true },
  focusHeldMs: { read: (r) => r.focus.heldMs, time: true },
  slowestScreenMs: { read: (r) => r.focus.slowestScreenMs, time: true },
  peakMb: { read: (r) => r.memory.peakMb, time: false },
  finalMb: { read: (r) => r.memory.finalMb, time: false },
  gpuPeakMb: { read: (r) => r.memory.gpuPeakMb, time: false }
}

/** Every case of every file in viewer-budgets/, checked for what a typo would otherwise turn into a silent pass. */
async function loadCases() {
  const folder = new URL('./viewer-budgets/', import.meta.url)
  const files = readdirSync(folder).filter((name) => name.endsWith('.mjs')).sort()
  const cases = []
  for (const file of files) {
    const module = await import(new URL(file, folder).href)
    if (!Array.isArray(module.cases)) throw new Error(`viewer-budgets/${file} が cases を export していません`)
    for (const one of module.cases) {
      const where = `viewer-budgets/${file} の ${one.name}`
      if (!one.name || cases.some((other) => other.name === one.name)) throw new Error(`${where}: name がないか、ほかの case と同じです`)
      if (!VIEWER_FILES[one.file]) throw new Error(`${where}: file は ${Object.keys(VIEWER_FILES).join(', ')} のどれかです: ${one.file}`)
      const unknown = Object.keys(one.budget ?? {}).filter((key) => !BUDGETS[key])
      if (unknown.length || Object.keys(one.budget ?? {}).length === 0) throw new Error(`${where}: budget には ${Object.keys(BUDGETS).join(', ')} を書きます`)
      if (one.budget.completeMs !== undefined && !one.complete) throw new Error(`${where}: completeMs を測るには complete が要ります`)
      cases.push(one)
    }
  }
  return cases
}

const allCases = await loadCases()
const measured = values('measure')
const named = values('case')
const unknownCases = named.filter((name) => !allCases.some((one) => one.name === name))
if (unknownCases.length) throw new Error(`そういう case はありません: ${unknownCases.join(', ')}`)
const unknownFiles = measured.filter((name) => name !== 'all' && !VIEWER_FILES[name])
if (unknownFiles.length) throw new Error(`--measure は all か ${Object.keys(VIEWER_FILES).join(', ')} です: ${unknownFiles.join(', ')}`)
const runs = measured.length
  ? (measured.includes('all') ? Object.keys(VIEWER_FILES) : measured).map((file) => ({ name: file, file, budget: null }))
  : allCases.filter((one) => named.length === 0 || named.includes(one.name))
if (runs.length === 0) {
  console.log('viewer budgets  no case to run (viewer-budgets/ holds none)')
  process.exit()
}

const log = (line) => console.error(line)
const kept = single('files')
const root = kept ? path.resolve(kept) : mkdtempSync(path.join(os.tmpdir(), 'asist-viewer-files-'))
const results = []
let demo = null
try {
  const { folder, files } = await prepareFiles([...new Set(runs.map((run) => run.file))], root, log)
  demo = await startDemo({ files: folder })
  // The first page compiles the viewers' modules in Vite, which would otherwise count against the first case.
  {
    const chrome = await launchChrome()
    const client = await connect(chrome.port)
    await client.navigate(new URL(`${previewPath('/cards')}?type=files`, demo.origin).href)
    await waitForApp(client)
    await sleep(3000)
    client.close()
    await chrome.close()
  }
  for (const run of runs) {
    const { file, bytes } = files[run.file]
    log(`measuring ${run.name} (${file}, ${(bytes / 1024 / 1024).toFixed(1)} MB)`)
    const entry = { name: run.name, file, bytes, budget: run.budget }
    try {
      entry.result = await measureFile({
        origin: demo.origin,
        path: path.join(folder, file),
        url: `${SERVED_FILES_PATH}${encodeURIComponent(file)}`,
        sizeBytes: bytes,
        scrolls: VIEWER_FILES[run.file].scrolls !== false,
        ...(run.shown ? { shown: run.shown } : {}),
        ...(run.complete ? { complete: run.complete } : {})
      })
      // A value that is not a number is over any budget, rather than slipping past a comparison.
      entry.over = run.budget
        ? Object.entries(run.budget)
            .map(([key, limit]) => ({ key, limit: BUDGETS[key].time ? limit * timeFactor : limit, value: BUDGETS[key].read(entry.result) }))
            .filter(({ limit, value }) => !(value <= limit))
        : []
    } catch (error) {
      entry.error = error.message
    }
    results.push(entry)
  }
} finally {
  await demo?.close()
  if (!kept) rmSync(root, { recursive: true, force: true })
}

const ms = (value) => (value === undefined ? '' : `${value.toLocaleString('en-US')} ms`)
const mb = (value) => `${value >= 0 ? '+' : ''}${value.toLocaleString('en-US')} MB`
const columns = [
  ['case', (e) => e.name],
  ['file', (e) => `${e.file} (${(e.bytes / 1024 / 1024).toFixed(0)} MB)`],
  ['card first', (e) => ms(e.result?.card.firstMs)],
  ['complete', (e) => ms(e.result?.card.completeMs)],
  ['card held', (e) => ms(e.result?.card.heldMs)],
  ['card peak', (e) => (e.result ? mb(e.result.memory.cardPeakMb) : '')],
  ['focus first', (e) => ms(e.result?.focus.firstMs)],
  ['focus held', (e) => ms(e.result?.focus.heldMs)],
  ['screens', (e) => (e.result ? String(e.result.focus.screens) : '')],
  ['slowest screen', (e) => ms(e.result?.focus.slowestScreenMs)],
  ['peak', (e) => (e.result ? mb(e.result.memory.peakMb) : '')],
  ['final', (e) => (e.result ? mb(e.result.memory.finalMb) : '')],
  ['GPU peak', (e) => (e.result ? mb(e.result.memory.gpuPeakMb) : '')]
]
const rows = results.map((entry) => columns.map(([, cell]) => cell(entry)))
const widths = columns.map(([title], i) => Math.max(title.length, ...rows.map((row) => row[i].length)))
const line = (cells) => cells.map((cell, i) => (i < 2 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ')
const failed = results.filter((entry) => entry.error || entry.over.length > 0)
const alone = results.length === 1
const heading = `${results.length} ${measured.length ? `${alone ? 'file' : 'files'} measured without a budget` : `${alone ? 'case' : 'cases'}, times held to ${timeFactor}× their budgets`}`
const failures = failed.flatMap((entry) => [
  `${entry.name}: ${entry.error ? `failed: ${entry.error}` : 'over its budget'}`,
  ...(entry.over ?? []).map(({ key, limit, value }) => `  ${key} ${value?.toLocaleString('en-US')} is not within ${limit.toLocaleString('en-US')}`)
])
console.log([`viewer budgets  ${heading}`, line(columns.map(([title]) => title)), ...rows.map(line), ...(failures.length ? ['', ...failures] : [])].join('\n'))

const out = single('out')
if (out) {
  mkdirSync(out, { recursive: true })
  writeFileSync(path.join(out, 'viewer-budgets.json'), JSON.stringify({ timeFactor, results }, null, 2))
}
// On GitHub the table also goes to the run's summary page.
if (process.env.GITHUB_STEP_SUMMARY) {
  const cell = (text) => String(text).replace(/\|/g, '\\|')
  const summary = ['### demo:viewer-budgets', '', heading, '', `| ${columns.map(([title]) => title).join(' | ')} |`, `|${columns.map(() => ' --- ').join('|')}|`]
  for (const row of rows) summary.push(`| ${row.map(cell).join(' | ')} |`)
  if (failures.length) summary.push('', '```', ...failures, '```')
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`)
}
if (failed.length > 0) process.exitCode = 2
// The demo this run served leaves the process alive after it is closed (demo-server.mjs).
process.exit()
