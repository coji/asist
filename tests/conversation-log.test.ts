import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { expiredDatedFiles, localDateKey } from '@shared/local-date'
import {
  ConversationLog,
  logFileName,
  summarizeToolInput,
  summarizeToolResult
} from '../src/main/services/brain/conversation-log'

const readLines = (file: string): Array<Record<string, unknown>> =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)

function makeLog(opts?: { retentionDays?: number; now?: () => Date }): {
  log: ConversationLog
  dir: string
  errors: string[]
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'asist-conversations-'))
  const errors: string[] = []
  const log = new ConversationLog({
    dir,
    retentionDays: () => opts?.retentionDays ?? 30,
    now: opts?.now,
    onError: (stage, err) => errors.push(`${stage}: ${err instanceof Error ? err.message : String(err)}`)
  })
  return { log, dir, errors }
}

describe('logFileName', () => {
  it('names the file YYYY-MM-DD.jsonl after the local calendar date', () => {
    expect(logFileName(new Date(2026, 8, 8, 23, 59))).toBe('2026-09-08.jsonl')
    expect(logFileName(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01.jsonl')
    expect(localDateKey(new Date(2026, 8, 8, 23, 59))).toBe('2026-09-08')
  })
})

describe('ConversationLog', () => {
  // Windows has no POSIX permission bits; a file under the user's profile folder is guarded by that folder's access list.
  it.runIf(process.platform !== 'win32')('creates the day file readable by the user alone', () => {
    const { log, dir } = makeLog({ now: () => new Date(2026, 8, 8, 10, 30) })
    log.append({ kind: 'user', turnId: 1, text: 'メールを読んで' })
    expect(fs.statSync(path.join(dir, '2026-09-08.jsonl')).mode & 0o777).toBe(0o600)
  })

  it('appends user, assistant, tool and notice records, one per line, to the file of the current day', () => {
    const now = new Date(2026, 8, 8, 10, 30)
    const { log, dir } = makeLog({ now: () => now })
    log.append({ kind: 'user', turnId: 1, text: '明日の天気は' })
    log.append({
      kind: 'tool',
      turnId: 1,
      name: 'show_weather',
      input: '{"place":"大阪"}',
      result: '{"shown":true}',
      resultLength: 1400,
      durationMs: 320
    })
    log.append({ kind: 'assistant', turnId: 1, text: '明日は快晴です。' })
    log.append({ kind: 'notice', turnId: 2, notice: 'job-done', text: '[システム通知] 作業が終わりました' })

    const lines = readLines(path.join(dir, '2026-09-08.jsonl'))
    expect(lines.map((l) => l.kind)).toEqual(['user', 'tool', 'assistant', 'notice'])
    expect(lines[0]).toMatchObject({ t: now.getTime(), turnId: 1, text: '明日の天気は' })
    expect(lines[1]).toMatchObject({ name: 'show_weather', resultLength: 1400, durationMs: 320 })
    expect(lines[3]).toMatchObject({ notice: 'job-done' })
  })

  it('keeps the notes added to a user message and the ids of the memories shown and returned', () => {
    const now = new Date(2026, 8, 8, 10, 30)
    const { log, dir } = makeLog({ now: () => now })
    log.append({ kind: 'user', turnId: 1, text: 'ラーメン', notes: '[記憶]\n- 松葉軒', memoryIds: ['m1'] })
    log.append({
      kind: 'tool',
      turnId: 1,
      name: 'recall',
      input: '{"query":"猫"}',
      result: '{"hits":[{"id":"m2"}]}',
      resultLength: 20,
      durationMs: 3,
      memoryIds: ['m2', 'm3']
    })
    const lines = readLines(path.join(dir, '2026-09-08.jsonl'))
    expect(lines[0]).toMatchObject({ text: 'ラーメン', notes: '[記憶]\n- 松葉軒', memoryIds: ['m1'] })
    expect(lines[1]).toMatchObject({ name: 'recall', memoryIds: ['m2', 'm3'] })
    expect(log.readDay(now).map((r) => r.kind)).toEqual(['user', 'tool'])
  })

  it('starts a new file when the date changes and deletes the files older than the retention period', () => {
    let now = new Date(2026, 8, 8, 12, 0)
    const { log, dir, errors } = makeLog({ retentionDays: 3, now: () => now })
    for (const name of ['2026-09-04.jsonl', '2026-09-05.jsonl', 'notes.txt']) {
      fs.writeFileSync(path.join(dir, name), '{"kind":"user"}\n')
    }
    log.append({ kind: 'user', turnId: 1, text: 'a' })
    // With three days of retention on 09-08, 09-05 and later stay, 09-04 goes, and unrelated files are untouched.
    expect(fs.readdirSync(dir).sort()).toEqual(['2026-09-05.jsonl', '2026-09-08.jsonl', 'notes.txt'])

    now = new Date(2026, 8, 9, 0, 5)
    log.append({ kind: 'user', turnId: 2, text: 'b' })
    expect(fs.readdirSync(dir).sort()).toEqual(['2026-09-08.jsonl', '2026-09-09.jsonl', 'notes.txt'])
    expect(readLines(path.join(dir, '2026-09-09.jsonl'))).toHaveLength(1)
    expect(errors).toEqual([])
  })

  it('reports an invalid retention period through onError, deletes nothing, and keeps appending', () => {
    const { log, dir, errors } = makeLog({ retentionDays: 0, now: () => new Date(2026, 8, 8) })
    fs.writeFileSync(path.join(dir, '2020-01-01.jsonl'), '')
    log.append({ kind: 'user', turnId: 1, text: 'a' })
    expect(fs.existsSync(path.join(dir, '2020-01-01.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(dir, '2026-09-08.jsonl'))).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('prune')
  })

  it('stores a message with its parts and the provider payload, and skips lines without parts', () => {
    const now = new Date(2026, 8, 8, 12, 0)
    const { log, dir, errors } = makeLog({ now: () => now })
    const native = { provider: 'openai' as const, model: 'gpt-5.5', payload: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' }] }
    log.append({ kind: 'message', turnId: 1, role: 'assistant', parts: [{ type: 'text', text: '快晴です。' }], native })
    fs.appendFileSync(path.join(dir, logFileName(now)), JSON.stringify({ t: 1, kind: 'message', turnId: 2, role: 'assistant', content: 'x' }) + '\n')
    fs.appendFileSync(
      path.join(dir, logFileName(now)),
      JSON.stringify({ t: 2, kind: 'checkpoint', summary: 's', records: [{ t: 1, kind: 'message', turnId: 2, role: 'user', content: [] }] }) + '\n'
    )
    // An unreadable line kept in the history would send a message the API cannot accept.
    expect(log.readDay(now)).toEqual([expect.objectContaining({ kind: 'message', turnId: 1, parts: [{ type: 'text', text: '快晴です。' }], native })])
    // However many lines are unreadable, the error is reported once per file.
    expect(errors).toEqual(['read: 2026-09-08.jsonl: skipped 2 unreadable line(s)'])
  })
})

describe('expiredDatedFiles', () => {
  it('returns only the files dated before today minus retentionDays whose extension matches', () => {
    const names = ['2026-08-01.jsonl', '2026-09-01.jsonl', '2026-09-07.jsonl', 'x.jsonl', '2026-09-08.jsonl.tmp', '2026-08-01.log']
    expect(expiredDatedFiles(names, new Date(2026, 8, 8), 7, 'jsonl')).toEqual(['2026-08-01.jsonl'])
    expect(expiredDatedFiles(names, new Date(2026, 8, 8), 1, 'jsonl')).toEqual(['2026-08-01.jsonl', '2026-09-01.jsonl'])
    expect(expiredDatedFiles(names, new Date(2026, 8, 8), 7, 'log')).toEqual(['2026-08-01.log'])
  })
})

describe('summaries', () => {
  it('serializes the tool input as JSON and cuts it at the limit', () => {
    expect(summarizeToolInput({ place: '大阪' })).toBe('{"place":"大阪"}')
    const long = summarizeToolInput({ prompt: 'x'.repeat(500) }, 50)
    expect(long).toHaveLength(51)
    expect(long.endsWith('…')).toBe(true)
  })

  it('keeps only the beginning of the tool result', () => {
    expect(summarizeToolResult('short')).toBe('short')
    expect(summarizeToolResult('a'.repeat(300), 100)).toBe('a'.repeat(100) + '…')
  })
})

describe('reading a day of the log', () => {
  it('finds no records for a day with no file', () => {
    const { log } = makeLog()
    expect(log.readDay(new Date(2026, 8, 8))).toEqual([])
  })

  it('throws for a day file that exists but cannot be read, rather than pass for a day with nothing said', () => {
    const { log, dir } = makeLog()
    // A directory in the file's place fails the read with EISDIR on every system, as a permission error would.
    fs.mkdirSync(path.join(dir, '2026-09-08.jsonl'))
    expect(() => log.readDay(new Date(2026, 8, 8))).toThrow()
  })
})
