import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CURATION_SKILL, SKILL_DIRS, curationSkillSource } from '@shared/memory-curation'
import { FIXED, validateDocument } from '@shared/memory-page'
import { createTranslator } from '@shared/i18n'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => tmpdir() } }))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ uiLocale: 'ja-JP', conversationLocale: 'ja-JP', region: 'JP' })
}))

import { installSkill } from '../src/main/services/memory-curation-skill'

const ja = createTranslator('ja-JP')

const LOCALES = ['ja-JP', 'en-US'] as const
const TEMPLATES = ['page', 'user', 'me', 'journal', 'instruction']
const skillDir = (locale: 'ja-JP' | 'en-US'): string => path.join(process.cwd(), 'resources', 'skills', curationSkillSource(locale))
const validate = (skill: string, dir: string): { ok: boolean; output: string } => {
  try {
    return { ok: true, output: execFileSync('node', [path.join(skill, 'scripts', 'validate.mjs'), dir], { encoding: 'utf8' }) }
  } catch (err) {
    return { ok: false, output: String((err as { stdout?: string }).stdout ?? '') }
  }
}
/** The file, and the line where there is one, that each problem is about, without its wording. */
const places = (output: string): string[] =>
  output
    .split('\n')
    .filter(Boolean)
    .map((line) => /^([^:]+?)(:\d+)?:/.exec(line)?.slice(1).filter(Boolean).join('') ?? line)

/** A directory laid out the way the skill asks, which both validators accept. */
function wellFormed(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'asist-memory-skill-'))
  fs.mkdirSync(path.join(dir, 'pages'))
  fs.mkdirSync(path.join(dir, 'journal'))
  fs.writeFileSync(
    path.join(dir, 'instruction.md'),
    '# いつも覚えておくこと\n\n## この人について\n最寄り駅は三鷹駅。\n\n## 私について\n落ち着いて話す。\n\n## 頼まれていること\n一言でと言われたら一言で返す。\n'
  )
  fs.writeFileSync(path.join(dir, 'user.md'), '---\nupdated: 2026-09-22\n---\n# ユーザー\n\n## 好み\n麺類が好きで、辛さは控えめを選ぶ。\n')
  fs.writeFileSync(path.join(dir, 'me.md'), '---\nupdated: 2026-09-22\n---\n# 私について\n\n落ち着いて話す。\n')
  fs.writeFileSync(
    path.join(dir, 'pages', '松葉軒.md'),
    '---\naliases:\n  - 松葉軒\n  - いつものラーメン\nupdated: 2026-09-22\n---\n# 松葉軒\n\n## 要約\n行きつけの店。\n\n## 私の印象\n疲れた日に名前が出る。\n'
  )
  fs.writeFileSync(path.join(dir, 'journal', '2026-09-08.md'), '# 2026-09-08\n\n## 食事\n麺類の話。\n\n## 今日の私\n静かな日。\n')
  return dir
}

/** The problems both skills report for a directory; they must agree on every file and line. */
function problemsIn(dir: string): string[] {
  const [ja, en] = LOCALES.map((locale) => validate(skillDir(locale), dir))
  expect(ja.ok).toBe(false)
  expect(en.ok).toBe(false)
  expect(places(en.output)).toEqual(places(ja.output))
  return places(ja.output)
}

describe('the memory-curation skill', () => {
  it('names the skill after the directory it is installed into, ships every reference, template and script it points at, and asks for a first-person journal', () => {
    const skill = fs.readFileSync(path.join(skillDir('ja-JP'), 'SKILL.md'), 'utf8')
    expect(skill).toContain('一人称')
    expect(skill).toContain(`## ${FIXED.journalSelf.ja}`)
    expect(skill).toContain(FIXED.impression.ja)
    expect(skill.startsWith(`---\nname: ${CURATION_SKILL}\ndescription: `)).toBe(true)
    for (const file of ['references/format.md', 'references/me.md', 'scripts/validate.mjs']) {
      expect(fs.existsSync(path.join(skillDir('ja-JP'), file))).toBe(true)
      expect(skill).toContain(file.split('/').pop()!)
    }
    for (const template of TEMPLATES) {
      expect(fs.existsSync(path.join(skillDir('ja-JP'), 'assets', 'templates', `${template}.md`))).toBe(true)
    }
    expect(skill.split('\n').length).toBeLessThan(500)
  })

  it('ships the same skill in English, telling the Agent to write the body in the conversation language under the English fixed headings', () => {
    const skill = fs.readFileSync(path.join(skillDir('en-US'), 'SKILL.md'), 'utf8')
    expect(skill.startsWith(`---\nname: ${CURATION_SKILL}\ndescription: `)).toBe(true)
    expect(skill).toContain('the language of the conversation')
    expect(skill).toContain(`## ${FIXED.summary.en}`)
    expect(skill).toContain(`## ${FIXED.journalSelf.en}`)
    expect(skill).toContain('first person')
    expect(skill.split('\n').length).toBeLessThan(500)
    for (const file of ['references/format.md', 'references/me.md', 'scripts/validate.mjs']) {
      expect(fs.existsSync(path.join(skillDir('en-US'), file))).toBe(true)
      expect(skill).toContain(file.split('/').pop()!)
    }
    // The templates carry the headings the app reads, so the two sets must line up file by file.
    for (const template of TEMPLATES) {
      expect(fs.existsSync(path.join(skillDir('en-US'), 'assets', 'templates', `${template}.md`))).toBe(true)
    }
    const template = (skill: string, name: string): string => fs.readFileSync(path.join(skill, 'assets', 'templates', `${name}.md`), 'utf8')
    const firstHeading = (skill: string, name: string): string => template(skill, name).split('\n').find((line) => line.startsWith('## ')) ?? ''
    expect(firstHeading(skillDir('en-US'), 'page')).toBe(`## ${FIXED.summary.en}`)
    expect(firstHeading(skillDir('ja-JP'), 'page')).toBe(`## ${FIXED.summary.ja}`)
    expect(template(skillDir('en-US'), 'journal')).toContain(`## ${FIXED.journalSelf.en}`)
    expect(template(skillDir('en-US'), 'user')).toContain(`# ${FIXED.user.en}`)
    expect(template(skillDir('en-US'), 'me')).toContain(`# ${FIXED.me.en}`)
    for (const file of ['SKILL.md', 'references/format.md', 'references/me.md']) {
      const text = fs.readFileSync(path.join(skillDir('en-US'), file), 'utf8')
      expect([file, /[぀-ヿ]/.test(text.replace(/^\|.*\|$/gm, ''))]).toEqual([file, false])
    }
  })

  it('builds every template into a directory that both validators accept', () => {
    for (const locale of LOCALES) {
      const templates = path.join(skillDir(locale), 'assets', 'templates')
      const dir = mkdtempSync(path.join(tmpdir(), 'asist-memory-skill-templates-'))
      fs.mkdirSync(path.join(dir, 'pages'))
      fs.mkdirSync(path.join(dir, 'journal'))
      const fill = (name: string): string => fs.readFileSync(path.join(templates, `${name}.md`), 'utf8').replaceAll('YYYY-MM-DD', '2026-09-22')
      fs.writeFileSync(path.join(dir, 'instruction.md'), fill('instruction'))
      fs.writeFileSync(path.join(dir, 'user.md'), fill('user'))
      fs.writeFileSync(path.join(dir, 'me.md'), fill('me'))
      fs.writeFileSync(path.join(dir, 'pages', 'Page.md'), fill('page'))
      fs.writeFileSync(path.join(dir, 'journal', '2026-09-22.md'), fill('journal'))
      for (const skill of LOCALES) expect([locale, skill, validate(skillDir(skill), dir)]).toEqual([locale, skill, { ok: true, output: 'OK\n' }])
    }
  })

  it('accepts a well-formed directory in both skills', () => {
    const dir = wellFormed()
    for (const locale of LOCALES) expect(validate(skillDir(locale), dir)).toEqual({ ok: true, output: 'OK\n' })
  })

  it('flags kind and links in any frontmatter, and aliases outside the pages', () => {
    const dir = wellFormed()
    fs.writeFileSync(path.join(dir, 'user.md'), '---\nkind: user\naliases: [本人]\n---\n# ユーザー\n\n## 好み\n麺類が好き。\n')
    fs.writeFileSync(path.join(dir, 'pages', '松葉軒.md'), '---\nlinks:\n  - ユーザー\n---\n# 松葉軒\n\n## 要約\n行きつけの店。\n')
    expect(problemsIn(dir)).toEqual(['user.md', 'user.md', 'pages/松葉軒.md'])
  })

  it('requires instruction.md, without frontmatter and with a title line and a heading', () => {
    const dir = wellFormed()
    fs.rmSync(path.join(dir, 'instruction.md'))
    expect(problemsIn(dir)).toEqual(['instruction.md'])
    fs.writeFileSync(path.join(dir, 'instruction.md'), '---\nupdated: 2026-09-22\n---\n最寄り駅は三鷹駅。\n')
    expect(problemsIn(dir)).toEqual(['instruction.md', 'instruction.md', 'instruction.md'])
  })

  it('counts instruction.md up to 2000 characters without whitespace, and flags it beyond', () => {
    const dir = wellFormed()
    // Five sections of 300 characters each, padded with whitespace that is not counted. The heading lines
    // are part of the body, so they count too.
    const body = Array.from({ length: 5 }, (_, i) => `## 見出し${i}\n${'あ '.repeat(300)}\n`).join('\n')
    const at = (extra: number): string => `# いつも覚えておくこと\n\n${body}${'い'.repeat(extra)}\n`
    const counted = 5 * ([...'##見出し0'].length + 300)
    fs.writeFileSync(path.join(dir, 'instruction.md'), at(2000 - counted))
    for (const locale of LOCALES) expect(validate(skillDir(locale), dir)).toEqual({ ok: true, output: 'OK\n' })
    fs.writeFileSync(path.join(dir, 'instruction.md'), at(2000 - counted + 1))
    expect(problemsIn(dir)).toEqual(['instruction.md'])
  })

  it('flags a section longer than 800 characters in every kind of file, at the line of its heading', () => {
    const dir = wellFormed()
    const long = 'あ'.repeat(801)
    const fits = 'い '.repeat(800)
    fs.writeFileSync(path.join(dir, 'user.md'), `---\n---\n# ユーザー\n\n## 好み\n${fits}\n\n## 習慣\n${long}\n`)
    fs.writeFileSync(path.join(dir, 'me.md'), `---\n---\n# 私について\n\n## 話し方\n${long}\n`)
    fs.writeFileSync(path.join(dir, 'pages', '松葉軒.md'), `---\n---\n# 松葉軒\n\n## 要約\n${long}\n`)
    fs.writeFileSync(path.join(dir, 'journal', '2026-09-08.md'), `# 2026-09-08\n\n## 食事\n${long.slice(0, 400)}\n${long.slice(400)}\n`)
    fs.writeFileSync(path.join(dir, 'instruction.md'), `# いつも覚えておくこと\n\n## この人について\n${long}\n`)
    expect(problemsIn(dir)).toEqual(['user.md:8','me.md:5', 'instruction.md:3', 'pages/松葉軒.md:5', 'journal/2026-09-08.md:3'])
  })

  it('flags profile.md and forget.jsonl while they remain', () => {
    const dir = wellFormed()
    fs.writeFileSync(path.join(dir, 'profile.md'), '# 要点\n\n- 最寄り駅は三鷹駅。\n')
    fs.writeFileSync(path.join(dir, 'forget.jsonl'), '{"text":"替え玉の話","date":"2026-09-09"}\n')
    expect(problemsIn(dir)).toEqual(['profile.md', 'forget.jsonl'])
  })

  it('flags a page whose first heading is not the summary, and a page or journal entry that breaks the layout', () => {
    const dir = wellFormed()
    fs.writeFileSync(path.join(dir, 'pages', '一蘭.md'), '---\naliases: [一蘭]\n---\n# 一蘭\n\n## 経緯\n行った。\n\n## 要約\nラーメン店。\n')
    fs.writeFileSync(path.join(dir, 'pages', '壊れ.md'), '# 壊れ\n\n## 要約\n\n')
    fs.writeFileSync(path.join(dir, 'journal', '2026-09-09.md'), '# 2026-09-09\n\n見出しの無い日記。\n')
    fs.writeFileSync(path.join(dir, 'tasks.md'), '# 約束\n- [ ] 古い約束\n')
    expect(problemsIn(dir)).toEqual(['pages/一蘭.md', 'pages/壊れ.md', 'pages/壊れ.md:3', 'journal/2026-09-09.md', 'tasks.md'])
  })

  it('reports every file exactly as the check ASIST runs before a merge does, so that nothing the Agent passes is refused', () => {
    const dir = wellFormed()
    const prose = '私は落ち着いて話すアシスタントで、確かめてから答えることを大事にしている。'.repeat(30)
    const files: Record<string, string> = {
      // me.md may go without a heading; its text is then one section, capped like any other.
      'me.md': `---\nupdated: 2026-09-22\n---\n# 私について\n\n${prose}\n`,
      'pages/大川俊介.md': '---\nupdated: 2026-09-20\n---\n# 大川俊介\n\n## 要約\n本人の上司。\n\n## 私の印象\n落ち着いた人。\n\n## 私の印象\nくるみアレルギーがある。\n',
      'pages/松葉軒.md': '---\naliases:\n- 松葉軒\nupdated: 2026-09-22\n---\n# 松葉軒\n行きつけの店。\n\n## 要約\nラーメン屋。\n',
      'journal/2026-09-09.md': '---\nupdated: 昨日\n---\n# 2026-09-09\n\n## 食事\n麺類の話。\n',
      'instruction.md': `# いつも覚えておくこと\n\n${'前置き。'.repeat(175)}\n\n## この人について\n${'あ'.repeat(700)}\n\n## 頼まれていること\n${'い'.repeat(700)}\n`
    }
    for (const [file, markdown] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), markdown)
    const reported = problemsIn(dir)
    for (const [file, markdown] of Object.entries(files)) {
      const app = validateDocument(file, markdown, ja)
      expect([file, app.length]).not.toEqual([file, 0])
      expect([file, reported.filter((place) => place === file || place.startsWith(`${file}:`)).length]).toEqual([file, app.length])
    }
  })

  it('runs its validate.mjs once installed into a worktree, where the rules it imports are copied beside it', () => {
    for (const locale of LOCALES) {
      const worktree = mkdtempSync(path.join(tmpdir(), 'asist-memory-skill-installed-'))
      installSkill(worktree, skillDir(locale))
      const dir = wellFormed()
      for (const skills of SKILL_DIRS) expect(validate(path.join(worktree, skills, CURATION_SKILL), dir)).toEqual({ ok: true, output: 'OK\n' })
      fs.writeFileSync(path.join(dir, 'pages', '壊れ.md'), '---\n---\n# 壊れ\n\n## 要約\n\n')
      for (const skills of SKILL_DIRS) expect(places(validate(path.join(worktree, skills, CURATION_SKILL), dir).output)).toEqual(['pages/壊れ.md:5'])
    }
  })

  it('reports a page whose name macOS or Windows cannot give a file, in both skills', () => {
    const dir = wellFormed()
    const page = fs.readFileSync(path.join(dir, 'pages', '松葉軒.md'), 'utf8')
    for (const name of ['CON', 'CONOUT$']) fs.writeFileSync(path.join(dir, 'pages', `${name}.md`), page)
    expect(problemsIn(dir).sort()).toEqual(['pages/CON.md', 'pages/CONOUT$.md'])
  })

  it('takes a directory that holds pages written under each of the two fixed headings, in both skills', () => {
    const dir = wellFormed()
    fs.writeFileSync(path.join(dir, 'pages', 'Matsubaken.md'), '---\nupdated: 2026-09-22\n---\n# Matsubaken\n\n## Summary\nThe ramen shop.\n')
    fs.writeFileSync(path.join(dir, 'journal', '2026-09-09.md'), '# 2026-09-09\n\n## Dinner\nWe talked about noodles.\n\n## Myself today\nA quiet day.\n')
    for (const locale of LOCALES) expect(validate(skillDir(locale), dir)).toEqual({ ok: true, output: 'OK\n' })
  })
})
