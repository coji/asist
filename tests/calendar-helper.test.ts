import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { errorText } from '../src/shared/i18n/error-text'

const mocks = vi.hoisted(() => ({ userData: '', stdout: '' }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData, getPreferredSystemLanguages: () => ['en-US'], isPackaged: false, getAppPath: () => '/nonexistent' },
  BrowserWindow: { getAllWindows: () => [] }
}))
// The helper process is replaced by an answer written the way asist-calendar.swift writes one.
vi.mock('node:child_process', () => ({
  execFile: (_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    setTimeout(() => callback(null, mocks.stdout), 0)
    return { stdin: { on: () => undefined, end: () => undefined } }
  }
}))
beforeAll(() => {
  mocks.userData = mkdtempSync(path.join(tmpdir(), 'asist-calendar-helper-'))
})
afterAll(() => rmSync(mocks.userData, { recursive: true, force: true }))

import { runCalendarNative } from '../src/main/services/calendar-eventkit'

async function failure(answer: unknown): Promise<string> {
  mocks.stdout = JSON.stringify(answer)
  const error = await runCalendarNative({ operation: 'get', eventId: 'x' }).then(
    () => null,
    (err: unknown) => err
  )
  if (!(error instanceof Error)) throw new Error('the helper call did not fail')
  return error.message
}

describe.runIf(process.platform === 'darwin')('the answer of the calendar helper', () => {
  it('turns the code of a failure into the message for it, which the reader sees in their own language', async () => {
    expect(await failure({ ok: false, error: 'eventNotFound' })).toBe(errorText('calendar.errors.eventNotFound'))
  })

  it('has a message for every code the helper can fail with', async () => {
    const source = readFileSync(path.join(__dirname, '../resources/native/macos/asist-calendar.swift'), 'utf8')
    const codes = [...new Set([...source.matchAll(/fail\("(\w+)"\)|\?\? "(\w+)"/g)].map((match) => match[1] ?? match[2]))]
    expect(codes.length).toBeGreaterThan(5)
    for (const code of codes) expect(await failure({ ok: false, error: code })).not.toBe(errorText('calendar.errors.helperBadResponse'))
  })

  it('reports an answer it cannot read, such as a sentence in place of a code', async () => {
    expect(await failure({ ok: false, error: '予定が見つかりません。再検索してください' })).toBe(errorText('calendar.errors.helperBadResponse'))
    mocks.stdout = 'not json'
    await expect(runCalendarNative({ operation: 'status' })).rejects.toThrow(errorText('calendar.errors.helperBadResponse'))
  })

  it('hands over the data of a successful answer', async () => {
    mocks.stdout = JSON.stringify({ ok: true, data: { authorization: 'fullAccess', calendars: [] } })
    await expect(runCalendarNative({ operation: 'status' })).resolves.toEqual({ authorization: 'fullAccess', calendars: [] })
  })
})
