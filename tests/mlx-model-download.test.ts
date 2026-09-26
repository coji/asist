import { getEventListeners } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SetupProgress } from '@shared/ipc'

const mocks = vi.hoisted(() => ({ userData: '' }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => mocks.userData, on: vi.fn() }
}))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ uiLocale: 'en-US' }) }))

import { prepareModel, snapshotPath } from '../src/main/services/mlx-runtime'

const MODEL = { id: 'test-org/test-model', revision: 'abc123', label: 'Test Model', files: ['config.json', 'model.safetensors', 'tokenizer.json'] }

/**
 * A stand-in for the environment's python. For hf_snapshot.py it prints the repository's size, writes
 * the weights into the cache in three steps like a download, links every file into the snapshot, and
 * records its pid; for a worker script it reports ready. With FAKE_DOWNLOAD_HANG set the download never ends.
 * The pid file appears by a rename: a redirection creates the file before it writes, and a test that saw it
 * empty read pid 0, which names the test's own process group and never stops existing.
 * It exits at once unless it was started in Python's UTF-8 mode, which Python on Windows needs to read the
 * JSON lines.
 */
const FAKE_PYTHON = `#!/bin/sh
[ "$PYTHONUTF8" = 1 ] || exit 9
case "$1" in
  *hf_snapshot.py)
    echo $$ > "$FAKE_PID_FILE.tmp"
    mv "$FAKE_PID_FILE.tmp" "$FAKE_PID_FILE"
    cache="$HOME/.cache/huggingface/hub/models--$(echo "$2" | sed 's#/#--#')"
    mkdir -p "$cache/blobs" "$cache/snapshots/$3"
    echo 'ASIST_JSON:{"type":"total","bytes":3000000}'
    for step in 1 2 3; do
      head -c 1000000 /dev/zero >> "$cache/blobs/weights.incomplete"
      sleep 0.6
      [ -n "$FAKE_DOWNLOAD_HANG" ] && sleep 60
    done
    mv "$cache/blobs/weights.incomplete" "$cache/blobs/weights"
    cp "$cache/blobs/weights" "$cache/snapshots/$3/model.safetensors"
    echo '{}' > "$cache/snapshots/$3/config.json"
    echo '{}' > "$cache/snapshots/$3/tokenizer.json"
    ;;
  *)
    [ -f "$2/model.safetensors" ] || exit 3
    echo 'ASIST_JSON:{"type":"ready"}'
    cat > /dev/null
    ;;
esac
`

let root = ''
const saved = { HOME: process.env.HOME, ASIST_MLX_PYTHON: process.env.ASIST_MLX_PYTHON, FAKE_PID_FILE: process.env.FAKE_PID_FILE }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-mlx-download-'))
  mocks.userData = path.join(root, 'userData')
  const python = path.join(root, 'python')
  fs.writeFileSync(python, FAKE_PYTHON, { mode: 0o755 })
  process.env.HOME = path.join(root, 'home')
  process.env.ASIST_MLX_PYTHON = python
  process.env.FAKE_PID_FILE = path.join(root, 'download.pid')
})

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  delete process.env.FAKE_DOWNLOAD_HANG
  fs.rmSync(root, { recursive: true, force: true })
})

describe.runIf(process.platform === 'darwin' && process.arch === 'arm64')('preparing an MLX model', { timeout: 20_000 }, () => {
  it('downloads the whole model before it starts the worker, and reports the bytes against the size', async () => {
    const progress: SetupProgress[] = []
    let installedWhenStarted = false
    const result = await prepareModel({
      model: MODEL,
      feature: 'Test',
      signal: new AbortController().signal,
      onProgress: (event) => progress.push(event),
      start: async () => {
        installedWhenStarted = fs.existsSync(path.join(snapshotPath(MODEL), 'model.safetensors'))
        return true
      }
    })
    expect(result.ok).toBe(true)
    expect(installedWhenStarted).toBe(true)
    const measured = progress.filter((event) => event.totalMb > 0)
    expect(measured.length).toBeGreaterThan(0)
    expect(measured.every((event) => event.totalMb === 3)).toBe(true)
    expect(measured.map((event) => event.downloadedMb)).toEqual([...measured.map((event) => event.downloadedMb)].sort((a, b) => a - b))
    expect(progress.at(-1)?.status).toBe('done')
  })

  it('stops the download when cancelled, reports it as cancelled, and starts no worker', async () => {
    process.env.FAKE_DOWNLOAD_HANG = '1'
    const controller = new AbortController()
    const start = vi.fn(async () => true)
    const outcome = prepareModel({ model: MODEL, feature: 'Test', signal: controller.signal, onProgress: () => {}, start })
    await vi.waitFor(() => expect(fs.existsSync(process.env.FAKE_PID_FILE!)).toBe(true), { timeout: 5_000 })
    const pid = Number(fs.readFileSync(process.env.FAKE_PID_FILE!, 'utf8'))
    expect(pid).toBeGreaterThan(0)
    controller.abort()
    const result = await outcome
    expect(result.ok).toBe(false)
    expect(start).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000 })
  })

  it('downloads again a snapshot that an interrupted download left without some of its files', async () => {
    const snapshot = snapshotPath(MODEL)
    fs.mkdirSync(snapshot, { recursive: true })
    fs.writeFileSync(path.join(snapshot, 'config.json'), '{}')
    fs.writeFileSync(path.join(snapshot, 'model.safetensors'), 'x')
    const result = await prepareModel({
      model: MODEL,
      feature: 'Test',
      signal: new AbortController().signal,
      onProgress: () => {},
      start: async () => fs.existsSync(path.join(snapshot, 'tokenizer.json'))
    })
    expect(result.ok).toBe(true)
    expect(fs.existsSync(process.env.FAKE_PID_FILE!)).toBe(true)
  })

  it('fails a download whose python cannot be started, and leaves nothing listening on the signal', async () => {
    fs.chmodSync(process.env.ASIST_MLX_PYTHON!, 0o644)
    const controller = new AbortController()
    const start = vi.fn(async () => true)
    const result = await prepareModel({ model: MODEL, feature: 'Test', signal: controller.signal, onProgress: () => {}, start })
    expect(result.ok).toBe(false)
    expect(start).not.toHaveBeenCalled()
    expect(getEventListeners(controller.signal, 'abort')).toEqual([])
  })
})
