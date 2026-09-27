import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/unused', getPreferredSystemLanguages: () => ['ja-JP'] } }))

import { openStoredContent, storedContent, type StoredFormat } from '@shared/stored-format'
import { SETTINGS_FORMAT } from '@shared/settings'
import { TASKS_FORMAT } from '@shared/tasks'
import { TIMERS_FORMAT } from '@shared/timer-manager'
import { secretFileFormat } from '../src/main/services/encrypted-secrets'
import { DRAFTS_FORMAT } from '../src/main/services/mail-drafts'
import { JOBS_FORMAT } from '../src/main/services/job-history'
import { USAGE_FORMAT } from '../src/main/services/usage-ledger'
import { CURATION_STATE_FORMAT } from '../src/main/services/memory-curation-state'
import { PROJECTS_FORMAT } from '../src/main/services/project-index'

/**
 * tests/fixtures/stored keeps a sample of each stored file for every version that was released, named
 * <file>.v<version>.json. Each has to open as the current version, and the result has to survive being
 * written and read again.
 */

const SAMPLES = path.join(__dirname, 'fixtures', 'stored')

const FORMATS: StoredFormat<unknown>[] = [
  SETTINGS_FORMAT,
  TASKS_FORMAT,
  TIMERS_FORMAT,
  secretFileFormat('api-keys.json', () => 'broken'),
  secretFileFormat('google-calendar.json', () => 'broken'),
  DRAFTS_FORMAT,
  JOBS_FORMAT,
  USAGE_FORMAT,
  CURATION_STATE_FORMAT,
  PROJECTS_FORMAT
] as StoredFormat<unknown>[]

const samplesOf = (format: StoredFormat<unknown>): string[] => {
  const stem = path.basename(format.name, '.json')
  return fs.readdirSync(SAMPLES).filter((file) => new RegExp(`^${stem}\\.v\\d+\\.json$`).test(file))
}

describe('the samples of the released versions of each stored file', () => {
  // Without a sample of the current version, a change to the form that does not raise the version goes unnoticed.
  it.each(FORMATS.map((format) => [format.name, format] as const))('has a sample of the current version of %s', (_name, format) => {
    expect(samplesOf(format)).toContain(`${path.basename(format.name, '.json')}.v${format.version}.json`)
  })

  const cases = FORMATS.flatMap((format) => samplesOf(format).map((file) => [file, format] as const))
  it.each(cases)('opens %s as the current version and reads back what it writes', (file, format) => {
    const opened = openStoredContent(format, JSON.parse(fs.readFileSync(path.join(SAMPLES, file), 'utf8')))
    const written = JSON.parse(JSON.stringify(storedContent(format, opened.value))) as unknown
    expect(openStoredContent(format, written)).toEqual({ value: opened.value, storedVersion: format.version })
  })
})
