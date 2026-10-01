import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * What the aizuchi review page of the demo (/aizuchi) reads and writes: every clip under
 * resources/aizuchi/<engine>/<voice>/, the candidates build.mjs kept beside it in .aizuchi-candidates/, the
 * verdicts in the manifests, and renders of build.mjs started from the page. The demo's development server
 * serves it under /__aizuchi/ through aizuchiReview(); nothing of it reaches the app.
 *
 * A clip is accepted once someone listened to it and chose it (`reviewed` in the manifest), which keeps
 * build.mjs from rendering it again. A rejected one carries the note (`rejected`) until build.mjs renders it again.
 */

/** A name of an engine, a voice or a file. It cannot start with a dot, so that `..` never leaves the folders. */
const NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/
const ENGINES = ['irodori', 'qwen3tts']

const clipsDir = (root) => path.join(root, 'resources', 'aizuchi')
const candidatesDir = (root) => path.join(root, '.aizuchi-candidates')
const manifestPath = (root, engine, voice) => path.join(clipsDir(root), engine, voice, 'manifest.json')
const readManifest = (root, engine, voice) => JSON.parse(readFileSync(manifestPath(root, engine, voice), 'utf8'))
const writeManifest = (root, engine, voice, manifest) => writeFileSync(manifestPath(root, engine, voice), JSON.stringify(manifest, null, 2) + '\n')

function named(...names) {
  for (const name of names) if (typeof name !== 'string' || !NAME.test(name)) throw new Error(`not a name: ${name}`)
}

function candidatesOf(root, engine, voice, file) {
  const list = path.join(candidatesDir(root), engine, voice, path.basename(file, '.wav'), 'candidates.json')
  return existsSync(list) ? JSON.parse(readFileSync(list, 'utf8')) : []
}

/** Which candidate the clip is now, by its bytes, or null for a clip none of the kept candidates is. */
function currentOf(root, engine, voice, file, candidates) {
  const clip = readFileSync(path.join(clipsDir(root), engine, voice, file))
  const index = candidates.findIndex((candidate) => clip.equals(readFileSync(path.join(candidatesDir(root), engine, voice, path.basename(file, '.wav'), candidate.file))))
  return index >= 0 ? index : null
}

/** Every clip of every voice, in the order of the engines and the manifests, with its verdict and candidates. */
export function listClips(root) {
  const clips = []
  for (const engine of ENGINES) {
    const dir = path.join(clipsDir(root), engine)
    if (!existsSync(dir)) continue
    for (const voice of readdirSync(dir).filter((name) => NAME.test(name) && existsSync(manifestPath(root, engine, name))).sort()) {
      for (const clip of readManifest(root, engine, voice).clips) {
        const candidates = candidatesOf(root, engine, voice, clip.file)
        clips.push({
          engine,
          voice,
          text: clip.text,
          file: clip.file,
          status: clip.reviewed ? 'accepted' : clip.rejected ? 'rejected' : 'unreviewed',
          note: typeof clip.rejected === 'string' ? clip.rejected : null,
          candidates,
          current: currentOf(root, engine, voice, clip.file, candidates)
        })
      }
    }
  }
  return clips
}

/**
 * Writes a verdict. Accepting a candidate copies it over the clip; accepting without one keeps the clip as it
 * is. Undo takes the verdict back and leaves the clip as the last accept made it.
 */
export function decide(root, { engine, voice, file, verdict, candidate, note }) {
  named(engine, voice, file)
  const manifest = readManifest(root, engine, voice)
  const clip = manifest.clips.find((entry) => entry.file === file)
  if (!clip) throw new Error(`no clip ${file} in ${engine}/${voice}`)
  if (verdict === 'accept') {
    if (candidate !== null && candidate !== undefined) {
      const chosen = candidatesOf(root, engine, voice, file)[candidate]
      if (!chosen) throw new Error(`no candidate ${candidate} of ${file}`)
      copyFileSync(path.join(candidatesDir(root), engine, voice, path.basename(file, '.wav'), chosen.file), path.join(clipsDir(root), engine, voice, file))
    }
    clip.reviewed = true
    delete clip.rejected
  } else if (verdict === 'reject') {
    delete clip.reviewed
    clip.rejected = typeof note === 'string' && note.trim() ? note.trim() : true
  } else if (verdict === 'undo') {
    delete clip.reviewed
    delete clip.rejected
  } else throw new Error(`unknown verdict ${verdict}`)
  writeManifest(root, engine, voice, manifest)
}

/** The path of a clip or of one of its candidates, from the parts of an audio URL. */
export function audioPath(root, parts) {
  named(...parts)
  if (parts.length === 3) return path.join(clipsDir(root), ...parts)
  if (parts.length === 4) return path.join(candidatesDir(root), ...parts)
  throw new Error(`not an audio path: ${parts.join('/')}`)
}

/** The renders of build.mjs started from the page, by voice. A voice renders one at a time. */
const jobs = new Map()

/** Renders the rejected clips of a voice again with build.mjs, and returns at once. */
export function render(root, { engine, voice }) {
  named(engine, voice)
  const key = `${engine}/${voice}`
  if (jobs.get(key)?.running) throw new Error(`${key} is already rendering`)
  const texts = readManifest(root, engine, voice).clips.filter((clip) => clip.rejected).map((clip) => clip.text)
  if (texts.length === 0) throw new Error(`${key} has no rejected clip`)
  const job = { engine, voice, texts, done: 0, running: true, exitCode: null, log: '' }
  jobs.set(key, job)
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'aizuchi-clips', 'build.mjs'), engine, voice, '5', ...texts], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  child.stderr.on('data', (chunk) => {
    job.log += chunk
    job.done = (job.log.match(/ in \d+ readings/g) ?? []).length
  })
  child.on('exit', (code) => {
    job.running = false
    job.exitCode = code
  })
  return job
}

export const renders = () => [...jobs.values()].map(({ log: _log, ...job }) => job)

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => { try { resolve(JSON.parse(body)) } catch (error) { reject(error) } })
  })
}

/** The development server's routes under /__aizuchi/ for the demo's review page. */
export function aizuchiReview(root) {
  return {
    name: 'asist-aizuchi-review',
    configureServer(server) {
      server.middlewares.use('/__aizuchi', async (request, response) => {
        const url = new URL(request.url, 'http://localhost')
        const send = (status, body, type = 'application/json') => {
          response.writeHead(status, { 'content-type': type })
          response.end(type === 'application/json' ? JSON.stringify(body) : body)
        }
        try {
          if (request.method === 'GET' && url.pathname === '/clips') send(200, { clips: listClips(root), renders: renders() })
          else if (request.method === 'GET' && url.pathname.startsWith('/audio/')) {
            send(200, readFileSync(audioPath(root, url.pathname.slice('/audio/'.length).split('/'))), 'audio/wav')
          } else if (request.method === 'POST' && url.pathname === '/verdict') {
            decide(root, await readBody(request))
            send(200, { clips: listClips(root) })
          } else if (request.method === 'POST' && url.pathname === '/render') {
            render(root, await readBody(request))
            send(200, { renders: renders() })
          } else send(404, { error: 'not found' })
        } catch (error) {
          send(400, { error: error instanceof Error ? error.message : String(error) })
        }
      })
    }
  }
}
