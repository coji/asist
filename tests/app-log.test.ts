import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { redactSecrets, secretValues } from '@shared/app-log'
import { AppLog } from '../src/main/services/app-log'

/** Users attach the app log to bug reports, so these tests guard against leaked secrets and an unbounded file. */

function makeLog(opts: { now?: () => Date; env?: Record<string, string | undefined>; maxBytes?: number } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'asist-app-log-'))
  const errors: unknown[] = []
  const log = new AppLog({ dir, now: opts.now ?? (() => new Date(2026, 8, 21, 17, 5, 9, 42)), env: () => opts.env ?? {}, maxBytes: opts.maxBytes, onError: (err) => errors.push(err) })
  const read = (name: string): string => fs.readFileSync(path.join(dir, name), 'utf8')
  return { log, dir, errors, read }
}

describe('redacting secrets', () => {
  it('redacts the values of key and token variables inside error messages and nested objects', () => {
    const env = { OPENAI_API_KEY: 'sk-live-1234567890', MAIL_PASSWORD: 'hunter2hunter2', HOME: '/Users/someone', SHORT_KEY: 'abc' }
    const { log, read } = makeLog({ env })
    log.write('error', 'main', ['brain error:', new Error('401 Incorrect API key provided: sk-live-1234567890'), { headers: { authorization: 'Bearer sk-live-1234567890' } }])
    const text = read('2026-09-21.log')
    expect(text).not.toContain('sk-live-1234567890')
    expect(text).toContain('Incorrect API key provided: [redacted]')
  })

  it('redacts a saved API key that never enters the environment', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'asist-app-log-'))
    const log = new AppLog({ dir, now: () => new Date(2026, 8, 21, 17, 5, 9, 42), env: () => ({}), secrets: () => ['sk-ant-api03-saved-in-settings'] })
    log.write('error', 'main', [new Error('401 invalid x-api-key: sk-ant-api03-saved-in-settings')])
    const text = fs.readFileSync(path.join(dir, '2026-09-21.log'), 'utf8')
    expect(text).not.toContain('sk-ant-api03-saved-in-settings')
    expect(text).toContain('invalid x-api-key: [redacted]')
  })

  it('leaves short values alone and replaces longer values first', () => {
    expect(secretValues({ A_KEY: 'abc', B_TOKEN: 'long-enough-token', C_KEY: 'long-enough-token-extended', NAME: 'long-enough-name' })).toEqual([
      'long-enough-token-extended',
      'long-enough-token'
    ])
    expect(redactSecrets('x long-enough-token-extended y', ['long-enough-token-extended', 'long-enough-token'])).toBe('x [redacted] y')
  })
})

describe('AppLog', () => {
  it('writes time, level and source to the daily file and keeps stack trace lines', () => {
    const { log, read } = makeLog()
    log.write('warn', 'renderer', ['panel crashed (map)\n    at MapBody'])
    expect(read('2026-09-21.log')).toBe('2026-09-21 17:05:09.042 WARN  renderer panel crashed (map)\n    at MapBody\n')
  })

  // Windows has no POSIX permission bits; a file under the user's profile folder is guarded by that folder's access list.
  it.runIf(process.platform !== 'win32')('creates the daily file readable by the user alone, since error text can carry file paths and mail addresses', () => {
    const { log, dir } = makeLog()
    log.write('warn', 'renderer', ['panel crashed (map)'])
    expect(fs.statSync(path.join(dir, '2026-09-21.log')).mode & 0o077).toBe(0)
  })

  it('starts a new file when the date changes and deletes only expired logs', () => {
    let now = new Date(2026, 8, 21, 23, 59)
    const { log, dir } = makeLog({ now: () => now })
    for (const name of ['2026-09-01.log', '2026-09-10.log', '2026-09-01.jsonl']) fs.writeFileSync(path.join(dir, name), 'x\n')
    log.write('info', 'main', ['a'])
    now = new Date(2026, 8, 22, 0, 1)
    log.write('info', 'main', ['b'])
    expect(fs.readdirSync(dir).sort()).toEqual(['2026-09-01.jsonl', '2026-09-10.log', '2026-09-21.log', '2026-09-22.log'])
  })

  it('stops at the daily limit with a single notice, and stays stopped after a restart', () => {
    const { log, dir, read } = makeLog({ maxBytes: 200 })
    for (let i = 0; i < 20; i++) log.write('info', 'main', ['同じ出力が繰り返される'])
    const text = read('2026-09-21.log')
    expect(text.match(/reached its limit/g)).toHaveLength(1)
    const size = fs.statSync(path.join(dir, '2026-09-21.log')).size
    const again = new AppLog({ dir, now: () => new Date(2026, 8, 21, 18, 0), env: () => ({}), maxBytes: 200 })
    again.write('info', 'main', ['起動し直した'])
    expect(read('2026-09-21.log')).not.toContain('起動し直した')
    expect(fs.statSync(path.join(dir, '2026-09-21.log')).size).toBeLessThan(size + 200)
  })

  it('reports a write failure once and never throws', () => {
    const blocker = path.join(mkdtempSync(path.join(tmpdir(), 'asist-app-log-')), 'file')
    fs.writeFileSync(blocker, '')
    const errors: unknown[] = []
    const log = new AppLog({ dir: path.join(blocker, 'logs'), env: () => ({}), onError: (err) => errors.push(err) })
    log.write('info', 'main', ['a'])
    log.write('info', 'main', ['b'])
    expect(errors).toHaveLength(1)
  })
})
