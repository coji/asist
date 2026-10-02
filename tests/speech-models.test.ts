import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SetupProgress } from '@shared/ipc'
import type { PinnedFile } from '@shared/pinned-file'

const mocks = vi.hoisted(() => ({ directory: '' }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('electron', () => ({ app: { getPath: () => mocks.directory, getVersion: () => '0.0.0' } }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ uiLocale: 'en-US' }) }))

import { t } from '../src/main/services/i18n'
import { modelFilePath, prepareModelFiles } from '../src/main/services/speech-models'

const FILE: PinnedFile = { repo: 'owner/model-GGUF', revision: 'abc123', file: 'model.gguf', sha256: '0', bytes: 4 }

beforeEach(() => {
  mocks.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-speech-models-'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(mocks.directory, { recursive: true, force: true })
})

const install = (file: PinnedFile): void => {
  fs.mkdirSync(path.dirname(modelFilePath(file)), { recursive: true })
  fs.writeFileSync(modelFilePath(file), 'gguf')
}

describe('preparing the files of a local speech model', () => {
  it('starts the service on files that are already there without fetching anything', async () => {
    install(FILE)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const progress: SetupProgress[] = []
    const start = vi.fn(async () => true)
    const result = await prepareModelFiles({ files: [FILE], label: 'Model', feature: 'Speech', signal: new AbortController().signal, onProgress: (p) => progress.push(p), selected: () => true, start })
    expect(result).toEqual({ ok: true, message: t('settingsModels.preparation.done', { model: 'Model' }) })
    expect(fetch).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledOnce()
    expect(progress.at(-1)?.status).toBe('done')
  })

  it('reports a service that does not start on the files by the name of the model', async () => {
    install(FILE)
    const progress: SetupProgress[] = []
    const result = await prepareModelFiles({ files: [FILE], label: 'Model', feature: 'Speech', signal: new AbortController().signal, onProgress: (p) => progress.push(p), selected: () => true, start: async () => false })
    expect(result).toEqual({ ok: false, message: t('settingsModels.preparation.startFailed', { model: 'Model' }) })
    expect(progress.at(-1)?.status).toBe('error')
  })

  it('starts nothing and reports the files prepared when the settings no longer select the model once they are there', async () => {
    install(FILE)
    const progress: SetupProgress[] = []
    const start = vi.fn(async () => true)
    const result = await prepareModelFiles({ files: [FILE], label: 'Model', feature: 'Speech', signal: new AbortController().signal, onProgress: (p) => progress.push(p), selected: () => false, start })
    expect(result.ok).toBe(true)
    expect(start).not.toHaveBeenCalled()
    expect(progress.at(-1)?.status).toBe('done')
  })

  it('does not count a start as failed when the settings turned away from the model while it loaded', async () => {
    install(FILE)
    let selected = true
    const result = await prepareModelFiles({
      files: [FILE],
      label: 'Model',
      feature: 'Speech',
      signal: new AbortController().signal,
      onProgress: () => {},
      selected: () => selected,
      // The change of the setting stops the model that was loading.
      start: async () => {
        selected = false
        return false
      }
    })
    expect(result.ok).toBe(true)
  })

  it('reports a preparation stopped during the download as cancelled and starts nothing', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      controller.abort()
      throw init?.signal?.reason ?? new DOMException('aborted', 'AbortError')
    }))
    const start = vi.fn(async () => true)
    const progress: SetupProgress[] = []
    const result = await prepareModelFiles({ files: [FILE], label: 'Model', feature: 'Speech', signal: controller.signal, onProgress: (p) => progress.push(p), selected: () => true, start })
    expect(result).toEqual({ ok: false, message: t('settingsModels.preparation.cancelled', { feature: 'Speech' }) })
    expect(progress.at(-1)?.status).toBe('cancelled')
    expect(start).not.toHaveBeenCalled()
    expect(fs.existsSync(modelFilePath(FILE))).toBe(false)
  })
})
