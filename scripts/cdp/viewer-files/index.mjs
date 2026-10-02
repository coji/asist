import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { connect, launchChrome } from '../cdp.mjs'
import { writeM4a, writeMp3, writeWav } from './audio.mjs'
import { OFFICE_TEMPLATES, writeDocx, writePptx, writeXlsx } from './office.mjs'
import { writePdf } from './pdf.mjs'
import { PHOTO_SCRIPT } from './photos.mjs'
import { writeArchive } from './zip.mjs'

/**
 * The large files the viewers of the files card are measured with (npm run demo:viewer-budgets), each as large as
 * a real file of its kind gets: a case names one by its key. `chrome` marks the files whose photos or pages a
 * headless Chrome draws, and `scrolls: false` those whose focus view has nothing to scroll. The sizes are in MiB.
 * All ten were written in 74 s on an M5 on 2026-10-02, the 1,000-page PDF taking the longest at 22 s.
 */
export const VIEWER_FILES = {
  'pdf-200': {
    file: 'report-200-pages.pdf',
    about: 'a 200-page report printed from Chrome, a photo on every other page (46 MB)',
    chrome: true,
    make: (target, chrome) => writePdf(chrome, target, { pages: 200, photoEvery: 2, title: '年次報告書' })
  },
  'pdf-1000': {
    file: 'manual-1000-pages.pdf',
    about: 'a 1,000-page manual printed from Chrome, a photo on every fifth page (95 MB)',
    chrome: true,
    make: (target, chrome) => writePdf(chrome, target, { pages: 1000, photoEvery: 5, title: '製品マニュアル' })
  },
  'pptx-200': {
    file: 'deck-200-slides.pptx',
    about: 'a 200-slide deck, a phone photo on five slides in six (146 MB)',
    chrome: true,
    make: (target, chrome) => writePptx(chrome, target, { slides: 200 })
  },
  'docx-300': {
    file: 'book-300-pages.docx',
    about: 'a Word report of about 300 pages with 100 photos (61 MB)',
    chrome: true,
    make: (target, chrome) => writeDocx(chrome, target, { pages: 300 })
  },
  'xlsx-50k': {
    file: 'sales-50000-rows.xlsx',
    about: 'a workbook of 50,000 sales records on one sheet (2.7 MB, 18 MB of sheet XML)',
    make: (target) => writeXlsx(target, { sheets: [{ name: '売上', rows: 50_000 }] })
  },
  'xlsx-sheets': {
    file: 'sales-5-years.xlsx',
    about: 'a workbook of five sheets of 40,000 sales records each (11 MB)',
    make: (target) => writeXlsx(target, { sheets: [2021, 2022, 2023, 2024, 2025].map((year) => ({ name: `${year}年`, rows: 40_000 })) })
  },
  'mp3-2h': {
    file: 'interview-2-hours.mp3',
    about: 'a two-hour talk as a 128 kbps stereo MP3 (110 MB; needs lame)',
    scrolls: false,
    make: (target) => writeMp3(target, { seconds: 7200, title: '取材の録音', artist: 'ASIST' })
  },
  'm4a-1h': {
    file: 'voice-memo-1-hour.m4a',
    about: 'a one-hour voice memo as 64 kbps AAC (29 MB; needs afconvert, which macOS has)',
    scrolls: false,
    make: (target) => writeM4a(target, { seconds: 3600 })
  },
  'wav-1h': {
    file: 'recording-1-hour.wav',
    about: 'a one-hour recording as 44.1 kHz 16-bit stereo WAV (606 MB)',
    scrolls: false,
    make: (target) => writeWav(target, { seconds: 3600, sampleRate: 44_100, channels: 2 })
  },
  zip: {
    file: 'project-export.zip',
    about: 'a 200 MB zip of exported files, which the files card shows as a file without reading it',
    scrolls: false,
    make: (target) => writeArchive(target, { megabytes: 200 })
  }
}

/**
 * What the files are written from: the code in this folder and the demo's Office samples. Files kept for later
 * runs sit in a folder named after it, so that a change to a generator writes them again.
 */
function generatorVersion() {
  const hash = createHash('sha256')
  const here = new URL('./', import.meta.url)
  for (const name of readdirSync(here).filter((entry) => entry.endsWith('.mjs')).sort()) hash.update(name).update(readFileSync(new URL(name, here)))
  for (const template of Object.values(OFFICE_TEMPLATES)) hash.update(readFileSync(template))
  return hash.digest('hex').slice(0, 12)
}

/**
 * Writes the named files into a folder of this generator's version inside `root`, except those already there,
 * and returns that folder with each file's name and size. A file is written under a temporary name and renamed
 * when it is complete, so a run that was stopped leaves nothing that a later run would take for a finished file.
 */
export async function prepareFiles(names, root, log) {
  const folder = path.join(root, generatorVersion())
  mkdirSync(folder, { recursive: true })
  let chrome = null
  let client = null
  const browser = async () => {
    if (!client) {
      chrome = await launchChrome()
      client = await connect(chrome.port)
      await client.evaluate(PHOTO_SCRIPT)
    }
    return client
  }
  try {
    for (const name of names) {
      const spec = VIEWER_FILES[name]
      const target = path.join(folder, spec.file)
      if (existsSync(target)) continue
      const partial = `${target}.partial`
      const started = Date.now()
      try {
        await spec.make(partial, spec.chrome ? await browser() : null)
      } catch (error) {
        rmSync(partial, { force: true })
        throw new Error(`${name} (${spec.about}) を作れませんでした: ${error.message}`, { cause: error })
      }
      renameSync(partial, target)
      log(`wrote ${spec.file}: ${(statSync(target).size / 1024 / 1024).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s`)
    }
  } finally {
    client?.close()
    await chrome?.close()
  }
  const files = Object.fromEntries(names.map((name) => [name, { file: VIEWER_FILES[name].file, bytes: statSync(path.join(folder, VIEWER_FILES[name].file)).size }]))
  return { folder, files }
}
