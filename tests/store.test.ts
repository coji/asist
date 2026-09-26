import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.userData } }))
beforeAll(() => {
  mocks.userData = mkdtempSync(path.join(tmpdir(), 'asist-store-'))
})

import { appendJsonl, dataPath, writeJson } from '../src/main/services/store'

// Windows has no POSIX permission bits; a file under the user's profile folder is guarded by that folder's access list.
describe.runIf(process.platform !== 'win32')('store', () => {
  it('creates a job log readable by the user alone', () => {
    appendJsonl('joblogs/job-1.events.jsonl', { type: 'text', text: 'output' })
    expect(fs.statSync(dataPath('joblogs/job-1.events.jsonl')).mode & 0o777).toBe(0o600)
  })

  it('writes a JSON file readable by the user alone', () => {
    writeJson('jobs.json', [])
    expect(fs.statSync(dataPath('jobs.json')).mode & 0o777).toBe(0o600)
  })
})
