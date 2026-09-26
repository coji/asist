import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO = path.resolve(import.meta.dirname, '..')
const LOCALES = ['ja-JP', 'en-US', 'fr-FR', 'de-DE', 'hi-IN', 'id-ID', 'it-IT', 'ko-KR', 'pt-BR', 'es-419', 'es-ES']
let root: string

/** A copy of the dictionary and one component that uses a key, for the script to edit. */
beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'asist-i18n-'))
  fs.cpSync(path.join(REPO, 'src/shared/i18n'), path.join(root, 'src/shared/i18n'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src/renderer'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src/renderer/View.tsx'), "t('solo.kicker')\nt(`memory.kind.${kind}`)\n")
  fs.mkdirSync(path.join(root, 'tests'))
  fs.mkdirSync(path.join(root, 'scripts'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const run = (...args: string[]): string =>
  execFileSync('node', [path.join(REPO, 'scripts/i18n.mjs'), ...args], { env: { ...process.env, I18N_ROOT: root }, encoding: 'utf8' })
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8')

describe('scripts/i18n.mjs', () => {
  it('moves a message into a new group with its uses, and removes the group it emptied from the index', () => {
    run('set', 'solo.kicker', JSON.stringify(Object.fromEntries(LOCALES.map((l) => [l, 'ひとつだけ']))))
    const before = read('src/shared/i18n/messages/solo.ts')
    run('move', 'solo.kicker', 'approval.kicker')
    expect(fs.existsSync(path.join(root, 'src/shared/i18n/messages/solo.ts'))).toBe(false)
    expect(read('src/shared/i18n/messages/approval.ts')).toContain(before.slice(before.indexOf('  kicker: {'), before.lastIndexOf('})')))
    const index = read('src/shared/i18n/index.ts')
    expect(index).toContain("import { approval } from './messages/approval'")
    expect(index).not.toContain("from './messages/solo'")
    expect(read('src/renderer/View.tsx')).toBe("t('approval.kicker')\nt(`memory.kind.${kind}`)\n")
    run('check')
  })

  it('moves a whole group, rewriting a key built from its prefix at run time', () => {
    run('move', 'memory.kind', 'notes.kind')
    expect(read('src/renderer/View.tsx')).toContain('t(`notes.kind.${kind}`)')
    expect(read('src/shared/i18n/messages/memory.ts')).not.toContain('\n  kind: {')
    run('check')
  })

  it('lists a key left inside a longer string or a regular expression, and fails, instead of passing silently', () => {
    fs.writeFileSync(path.join(root, 'tests/errors.test.ts'), "expect(e).toMatch('[asist:notes.card.title')\nexpect(e).toMatch(/notes\\.card\\.title/)\n")
    let failure: { status?: number; stderr?: string } = {}
    try {
      run('move', 'notes.card', 'notes.panel')
    } catch (error) {
      failure = error as { status?: number; stderr?: string }
    }
    expect(failure.status).toBe(1)
    expect(failure.stderr).toContain(`${path.join('tests', 'errors.test.ts')}:1:`)
    expect(failure.stderr).toContain(`${path.join('tests', 'errors.test.ts')}:2:`)
  })

  it('refuses a message that leaves out a language, and writes nothing', () => {
    const before = read('src/shared/i18n/messages/notes.ts')
    expect(() => run('set', 'notes.half', JSON.stringify({ 'ja-JP': '半分' }))).toThrow()
    expect(read('src/shared/i18n/messages/notes.ts')).toBe(before)
  })

  it('writes a new message in every language and takes it out again', () => {
    const before = read('src/shared/i18n/messages/notes.ts')
    run('set', 'notes.extra.label', JSON.stringify(Object.fromEntries(LOCALES.map((l) => [l, l === 'en-US' ? "it's" : '付け足し']))))
    expect(read('src/shared/i18n/messages/notes.ts')).toContain(`'en-US': "it's"`)
    run('check')
    run('remove', 'notes.extra.label')
    expect(read('src/shared/i18n/messages/notes.ts')).toBe(before)
  })
})
