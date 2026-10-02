import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { availableParallelism } from 'node:os'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { connect, launchChrome, sleep } from '../../../scripts/cdp/cdp.mjs'

/**
 * Renders index.html in headless Chrome by seeking its GSAP timeline, and writes the sound cues the
 * timeline declares for audio.py.
 *
 *   node scripts/render.mjs                     out/video.mp4 (no sound)
 *   node scripts/render.mjs --mb 1              a quick draft without motion blur
 *   node scripts/render.mjs --from 8 --to 16    only that part, to out/part-8-16.mp4
 *   node scripts/render.mjs --stills 3.5 14.5   out/stills/t3.5.jpg and t14.5.jpg
 *
 * Motion blur is the average of --mb samples spread over the half of each frame that a 180° shutter is
 * open. With 6 samples the fast camera moves still showed as steps; 16 hide them.
 *
 * Each worker is its own Chrome that renders a contiguous run of frames and pipes the JPEG samples into
 * its own ffmpeg, which averages the samples of each frame (tmix) and encodes the run. The runs are then
 * joined without re-encoding, so no frame is written to disk.
 */

const ROOT = resolve(import.meta.dirname, '..')
const OUT = resolve(ROOT, 'out')
const FPS = 30
const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mb: { type: 'string', default: '16' },
    shutter: { type: 'string', default: '0.5' },
    workers: { type: 'string', default: String(Math.max(1, availableParallelism() - 2)) },
    from: { type: 'string' },
    to: { type: 'string' },
    crf: { type: 'string', default: '12' },
    quality: { type: 'string', default: '93' },
    stills: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
})
const MB = Number(opt.mb)
const SHUTTER = Number(opt.shutter)

async function openPage() {
  const { port } = await launchChrome()
  const page = await connect(port)
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await page.navigate(pathToFileURL(resolve(ROOT, 'index.html')).href)
  // The page defines __ready once its scripts have run; it resolves when the fonts and images are decoded
  // and the timeline is built.
  while (!(await page.evaluate('typeof window.__ready === "object"'))) await sleep(100)
  await page.evaluate('window.__ready.then(() => true)')
  const { exceptions } = page.navigation()
  if (exceptions.length) throw new Error(exceptions.map((e) => e.text).join('\n'))
  return page
}

async function shoot(page, t) {
  await page.evaluate(`__seek(${t.toFixed(6)})`)
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: Number(opt.quality), optimizeForSpeed: true })
  return Buffer.from(data, 'base64')
}

/** The times of the samples that are averaged into frame f: MB samples spread evenly over the open shutter. */
const sampleTimes = (f) =>
  Array.from({ length: MB }, (_, k) => (f + (MB === 1 ? 0 : ((k + 0.5) / MB - 0.5) * SHUTTER)) / FPS)

function encoder(file) {
  const vf = MB > 1 ? ['-vf', `tmix=frames=${MB},select='eq(mod(n\\,${MB})\\,${MB - 1})',setpts=N/(${FPS}*TB)`] : []
  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS * MB), '-i', '-',
    ...vf, '-r', String(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', opt.crf, '-pix_fmt', 'yuv420p', file,
  ], { stdio: ['pipe', 'inherit', 'inherit'] })
  const done = new Promise((ok, fail) => ff.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg ${code}`)))))
  const write = (buf) => (ff.stdin.write(buf) ? Promise.resolve() : new Promise((ok) => ff.stdin.once('drain', ok)))
  return { write, end: () => (ff.stdin.end(), done) }
}

async function renderRun(index, f0, f1, dir, progress) {
  const page = await openPage()
  const file = resolve(dir, `run-${String(index).padStart(2, '0')}.mp4`)
  const enc = encoder(file)
  for (let f = f0; f < f1; f++) {
    for (const t of sampleTimes(f)) await enc.write(await shoot(page, Math.max(0, t)))
    progress(1)
  }
  await enc.end()
  page.close()
  return file
}

const page0 = await openPage()
const duration = await page0.evaluate('window.__duration')
mkdirSync(OUT, { recursive: true })
writeFileSync(resolve(OUT, 'cues.json'), JSON.stringify({
  duration, fps: FPS, music: await page0.evaluate('window.__music'), cues: await page0.evaluate('window.__cues'),
}, null, 1))

if (opt.stills) {
  mkdirSync(resolve(OUT, 'stills'), { recursive: true })
  for (const t of positionals.map(Number)) writeFileSync(resolve(OUT, `stills/t${t}.jpg`), await shoot(page0, t))
  page0.close()
  process.exit(0)
}
page0.close()

const from = Math.round(Number(opt.from ?? 0) * FPS)
const to = Math.round(Number(opt.to ?? duration) * FPS)
const total = to - from
const n = Math.min(Number(opt.workers), total)
const dir = resolve(OUT, 'runs')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
let doneFrames = 0
const started = Date.now()
const progress = (k) => {
  doneFrames += k
  if (doneFrames % 60 === 0 || doneFrames === total) {
    const s = (Date.now() - started) / 1000
    console.log(`${doneFrames}/${total} frames  ${s.toFixed(0)} s  (${(s / doneFrames * (total - doneFrames)).toFixed(0)} s left)`)
  }
}
const bounds = Array.from({ length: n + 1 }, (_, i) => from + Math.round((total * i) / n))
const files = await Promise.all(bounds.slice(0, -1).map((b, i) => renderRun(i, b, bounds[i + 1], dir, progress)))
const list = resolve(dir, 'list.txt')
writeFileSync(list, files.map((f) => `file '${f}'`).join('\n'))
const output = opt.out ? resolve(ROOT, opt.out) : resolve(OUT, opt.from || opt.to ? `part-${opt.from ?? 0}-${opt.to ?? duration}.mp4` : 'video.mp4')
await new Promise((ok, fail) =>
  spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', output], { stdio: 'inherit' })
    .on('exit', (code) => (code === 0 ? ok() : fail(new Error(`concat ${code}`)))))
rmSync(dir, { recursive: true, force: true })
console.log(`wrote ${output} in ${((Date.now() - started) / 1000).toFixed(0)} s`)
process.exit(0)
