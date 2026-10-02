import { describe, expect, it } from 'vitest'
import {
  documentOf,
  parseMemoryPageInput,
  validateDocument,
  classifyFile,
  embeddingTextOf,
  parsePage,
  unitId,
  unitsOfJournal,
  unitsOfPage
} from '@shared/memory-page'
import {
  PROMPT_DOCUMENT_MAX_TOKENS,
  SECTION_MAX_CHARS,
  promptBody,
  promptSize,
  textForTokens,
  tokenEstimate
} from '@shared/memory-format'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import TOKEN_SAMPLES from './fixtures/token-estimate-samples.json'

const ja = createTranslator('ja-JP')

const PAGE = `---
aliases: [松葉軒, ラーメン屋]
updated: 2026-09-09
---
# 松葉軒

## 要約
本人の行きつけのラーメン屋。麺類の気分のときにまず名前が出る。

## 行った記録
2026-09-08 に麺類の気分だと話した。
2026-09-09 に行ったと話した。

## 好み
辛さは控えめが好みらしい。
`

/** The same page as PAGE, written by a curation of a conversation held in another language. */
const PAGE_EN = `---
aliases: [Matsubaken, the ramen place]
updated: 2026-09-09
---
# Matsubaken

## Summary
The ramen shop this person keeps going back to. The first name that comes up in the mood for noodles.

## Visits
They said they were in the mood for noodles on 2026-09-08.
They said they had been on 2026-09-09.

## Tastes
They seem to prefer it not too spicy.
`

describe('parsePage', () => {
  it('reads the frontmatter, the title, and every heading with its body', () => {
    const page = parsePage(PAGE, 'fallback')
    expect(page.title).toBe('松葉軒')
    expect(page.titled).toBe(true)
    expect(page.frontmatter).toEqual({ present: true, aliases: ['松葉軒', 'ラーメン屋'], hasAliases: true, updated: '2026-09-09', obsoleteKeys: [] })
    expect(page.sections.map((s) => [s.line, s.heading, s.text])).toEqual([
      [7, '要約', '本人の行きつけのラーメン屋。麺類の気分のときにまず名前が出る。'],
      [10, '行った記録', '2026-09-08 に麺類の気分だと話した。\n2026-09-09 に行ったと話した。'],
      [14, '好み', '辛さは控えめが好みらしい。']
    ])
  })

  it('reads a body without a heading as the summary section, reports present=false when there is no frontmatter, and titles the page after the file when it has no name', () => {
    const page = parsePage('行きつけの店。\n二行目。\n', 'ichiran')
    expect(page.title).toBe('ichiran')
    expect(page.titled).toBe(false)
    expect(page.frontmatter.present).toBe(false)
    expect(page.sections).toEqual([{ line: 1, heading: '要約', text: '行きつけの店。\n二行目。' }])
  })

  it('reports a heading without a body, an unclosed frontmatter and a malformed updated as things to fix, and leaves the empty heading out of the sections', () => {
    const file = 'journal/2026-09-07.md'
    const markdown = '---\nupdated: 昨日\n---\n# x\n## 空\n\n## あり\n本文\n'
    expect(validateDocument(file, markdown, ja)).toEqual([
      ja('memory.check.updatedNotDate', { file }),
      ja('memory.check.headingWithoutText', { file, line: 5, heading: '空' })
    ])
    expect(parsePage(markdown, 'x').sections.map((s) => s.heading)).toEqual(['あり'])
    expect(validateDocument(file, '---\nupdated: 2026-09-09\n# x\n## 話\n本文\n', ja)).toContain(ja('memory.check.frontmatterUnclosed', { file }))
    expect(validateDocument(file, '---\nupdated: 2026-09-09\n---', ja)).not.toContain(ja('memory.check.frontmatterUnclosed', { file }))
  })

  it('reads a page written under the English fixed headings into the same structure as its Japanese twin', () => {
    const japanese = parsePage(PAGE, 'fallback')
    const english = parsePage(PAGE_EN, 'fallback')
    expect(english.sections.map((s) => s.line)).toEqual(japanese.sections.map((s) => s.line))
    expect(english.sections[0].heading).toBe('Summary')
    expect(english.sections[0].text.split('\n')).toHaveLength(1)
    expect(english.sections[1].text.split('\n')).toHaveLength(2)
    expect(parsePage('The shop they keep going back to.\n', 'matsubaken').sections).toEqual([
      { line: 1, heading: 'Summary', text: 'The shop they keep going back to.' }
    ])
  })

  it('reads a frontmatter list written on one line, indented under its key, or at the key\'s own indentation as a YAML library writes it', () => {
    const indented = parsePage('---\naliases:\n  - ムギ\n  - "ムギちゃん"\nupdated: 2026-09-09\n---\n# ムギ\n## 要約\n猫。\n', 'x')
    expect(indented.frontmatter).toEqual({ present: true, aliases: ['ムギ', 'ムギちゃん'], hasAliases: true, updated: '2026-09-09', obsoleteKeys: [] })
    expect(indented.sections).toEqual([{ line: 8, heading: '要約', text: '猫。' }])
    const flush = parsePage('---\naliases:\n- 松葉軒\n- ラーメン屋\nupdated: 2026-09-09\n---\n# 松葉軒\n\n## 要約\n本人の行きつけのラーメン屋。\n', 'x')
    expect(flush.frontmatter).toMatchObject({ aliases: ['松葉軒', 'ラーメン屋'], updated: '2026-09-09' })
  })

  it('reports kind and links as obsolete keys, and keeps the items of an obsolete list out of the aliases, indented or not', () => {
    const file = 'pages/松葉軒.md'
    const markdown = '---\nkind: place\nlinks:\n  - ユーザー\n- 田中さん\naliases:\n  - 松葉軒\n---\n# 松葉軒\n## 要約\n行きつけの店。\n'
    expect(parsePage(markdown, 'x').frontmatter.aliases).toEqual(['松葉軒'])
    expect(validateDocument(file, markdown, ja)).toEqual([
      ja('memory.check.obsoleteKey', { file, key: 'kind' }),
      ja('memory.check.obsoleteKey', { file, key: 'links' })
    ])
  })

  it('reports a section whose body passes the cap, counted without whitespace', () => {
    const file = 'journal/2026-09-07.md'
    const atCap = 'あ '.repeat(SECTION_MAX_CHARS / 2) + '\n' + 'い\t'.repeat(SECTION_MAX_CHARS / 2)
    expect(validateDocument(file, `# x\n## 長い\n${atCap}\n`, ja)).toEqual([])
    expect(validateDocument(file, `# x\n## 長い\n${'あ'.repeat(SECTION_MAX_CHARS + 1)}\n`, ja)).toEqual([
      ja('memory.check.sectionTooLong', { file, line: 2, heading: '長い', limit: SECTION_MAX_CHARS })
    ])
  })
})

describe('units', () => {
  it('derives the id from the file and the heading, so that rewriting the body leaves it unchanged', () => {
    expect(unitId('pages/松葉軒.md', '要約')).toBe(unitId('pages/松葉軒.md', '要約'))
    expect(unitId('pages/松葉軒.md', '要約')).not.toBe(unitId('pages/松葉軒.md', '好み'))
    expect(unitId('pages/松葉軒.md', '要約')).not.toBe(unitId('pages/田中.md', '要約'))
    expect(unitId('x', 'y')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('makes a unit of every heading of a page and of a journal entry', () => {
    const units = unitsOfPage('pages/松葉軒.md', parsePage(PAGE, '松葉軒'), '松葉軒')
    expect(units[0]).toMatchObject({ file: 'pages/松葉軒.md', line: 7, kind: 'section', page: '松葉軒', heading: '要約', aliases: ['松葉軒', 'ラーメン屋'], date: '2026-09-09', order: 0 })
    expect(units[2]).toMatchObject({ heading: '好み', order: 2 })
    const journal = unitsOfJournal('journal/2026-09-07.md', parsePage('# 2026-09-07\n## 四季の話\n春は桜。', '2026-09-07'), '2026-09-07')
    expect(journal[0]).toMatchObject({ kind: 'journal', page: '2026-09-07', heading: '四季の話', text: '春は桜。', date: '2026-09-07' })
  })

  it('decides the kind from the file path, with fixed names for user.md and me.md, journal/ for entries and pages/ for pages', () => {
    expect(classifyFile('user.md')).toEqual({ kind: 'user', title: 'ユーザー' })
    expect(classifyFile('me.md')).toEqual({ kind: 'me', title: '私について' })
    expect(classifyFile('instruction.md').kind).toBeNull()
    expect(classifyFile('profile.md').kind).toBeNull()
    expect(classifyFile('pages/田中部長.md')).toEqual({ kind: 'page', title: '田中部長' })
    expect(classifyFile('journal/2026-09-07.md')).toEqual({ kind: 'journal', title: '2026-09-07' })
    expect(classifyFile('README.md').kind).toBeNull()
  })

  it('prefixes the embedded text with the page name and the heading, and a journal entry with its date', () => {
    expect(embeddingTextOf({ file: 'pages/松葉軒.md', kind: 'section', page: '松葉軒', heading: '頼み方', text: '辛さは控えめ', date: '' })).toBe(
      '松葉軒 頼み方: 辛さは控えめ'
    )
    expect(embeddingTextOf({ file: 'journal/2026-09-07.md', kind: 'journal', page: '2026-09-07', heading: '四季', text: '春は桜', date: '2026-09-07' })).toBe(
      '2026-09-07の日記 四季: 春は桜'
    )
  })

  it('leaves a heading the template of the document wrote out of the embedded text, in either form, and keeps one anyone else wrote', () => {
    const embedded = (file: string, page: string, heading: string): string =>
      embeddingTextOf({ file, kind: file.startsWith('journal/') ? 'journal' : 'section', page, heading, text: 'x', date: '2026-09-20' })
    expect([
      embedded('pages/Mugi.md', 'Mugi', 'Summary'),
      embedded('pages/Mugi.md', 'Mugi', 'My impression'),
      embedded('pages/ムギ.md', 'ムギ', '私の印象'),
      embedded('journal/2026-09-20.md', '2026-09-20', 'Myself today'),
      embedded('journal/2026-09-20.md', '2026-09-20', 'A subject')
    ]).toEqual(['Mugi: x', 'Mugi: x', 'ムギ: x', 'Journal of 2026-09-20: x', 'Journal of 2026-09-20: x'])
    expect([
      embedded('pages/Mugi.md', 'Mugi', 'Walnut allergy'),
      embedded('pages/松葉軒.md', '松葉軒', '好み'),
      embedded('journal/2026-09-20.md', '2026-09-20', 'Bonsai')
    ]).toEqual(['Mugi Walnut allergy: x', '松葉軒 好み: x', 'Journal of 2026-09-20 Bonsai: x'])
  })

  it('names the journal in English in an entry written in another language, and leaves a Japanese entry as it was', () => {
    expect(embeddingTextOf({ file: 'journal/2026-09-07.md', kind: 'journal', page: '2026-09-07', heading: 'Seasons', text: 'Cherry blossoms in spring', date: '2026-09-07' })).toBe(
      'Journal of 2026-09-07 Seasons: Cherry blossoms in spring'
    )
    // The prefix follows the entry, not the language of the conversation, so changing the language sends
    // nothing already written back through the embedding worker.
    expect(embeddingTextOf({ file: 'journal/2026-09-07.md', kind: 'journal', page: '2026-09-07', heading: '四季', text: '春は桜', date: '2026-09-07' })).toContain('の日記')
    expect(embeddingTextOf({ file: 'pages/Matsubaken.md', kind: 'section', page: 'Matsubaken', heading: 'How they order', text: 'Mild', date: '' })).toBe(
      'Matsubaken How they order: Mild'
    )
  })
})

describe('documents', () => {
  const MATSUBAKEN = '---\naliases: [松葉軒, ラーメン屋]\nupdated: 2026-09-09\n---\n# 松葉軒\n\n## 要約\n本人の行きつけのラーメン屋。麺類の気分のときにまず名前が出る。\n\n## 好み\n辛さは控えめ。\n'

  it('builds the list entry of a document from its path and markdown, with kind, title, aliases, updated date, headings and the first sentence of the summary', () => {
    expect(documentOf('pages/松葉軒.md', MATSUBAKEN)).toEqual({
      file: 'pages/松葉軒.md',
      kind: 'page',
      title: '松葉軒',
      aliases: ['松葉軒', 'ラーメン屋'],
      updated: '2026-09-09',
      headings: ['要約', '好み'],
      summary: '本人の行きつけのラーメン屋。'
    })
    expect(documentOf('journal/2026-09-07.md', '# 2026-09-07\n## 四季の話\n春は桜を勧めた。\n')).toMatchObject({ kind: 'journal', title: '2026-09-07', updated: '2026-09-07', headings: ['四季の話'] })
    expect(documentOf('me.md', '---\nupdated: 2026-09-09\n---\n# 私について\n\n## 私は誰か\n落ち着いた声で話す。\n')).toMatchObject({ kind: 'me', title: '私について' })
    expect(() => documentOf('notes.md', '')).toThrow(errorText('memory.errors.notADocument', { file: 'notes.md' }))
  })

  it('reports what to fix in a page that breaks the rules', () => {
    expect(validateDocument('pages/壊れ.md', '# 壊れ\n\n## 経緯\n本文\n', ja)).toEqual([
      ja('memory.check.frontmatterMissing', { file: 'pages/壊れ.md' }),
      ja('memory.check.firstHeading', { file: 'pages/壊れ.md', heading: '要約' })
    ])
    expect(validateDocument('pages/松葉軒.md', MATSUBAKEN, ja)).toEqual([])
    expect(validateDocument('journal/2026-09-07.md', '# 2026-09-07\n## 四季の話\n春は桜を勧めた。\n', ja)).toEqual([])
    expect(validateDocument('../me.md', '', ja)).toEqual([ja('memory.check.wrongPlace', { file: '../me.md' })])
    expect(validateDocument('profile.md', '# 要点\n## 要点\n本文\n', ja)).toEqual([ja('memory.check.wrongPlace', { file: 'profile.md' })])
    expect(validateDocument('instruction.md', '# いつも覚えておくこと\n## この人について\n東京に住む。\n', ja)).toEqual([
      ja('memory.check.wrongPlace', { file: 'instruction.md' })
    ])
  })

  it('refuses the obsolete frontmatter keys kind and links', () => {
    expect(validateDocument('pages/松葉軒.md', '---\nkind: place\nlinks: [ユーザー]\nupdated: 2026-09-09\n---\n# 松葉軒\n## 要約\n行きつけの店。\n', ja)).toEqual([
      ja('memory.check.obsoleteKey', { file: 'pages/松葉軒.md', key: 'kind' }),
      ja('memory.check.obsoleteKey', { file: 'pages/松葉軒.md', key: 'links' })
    ])
  })

  it('refuses a section whose body is longer than the cap', () => {
    const markdown = `---\nupdated: 2026-09-09\n---\n# 松葉軒\n## 要約\n${'あ'.repeat(SECTION_MAX_CHARS + 1)}\n`
    expect(validateDocument('pages/松葉軒.md', markdown, ja)).toEqual([
      ja('memory.check.sectionTooLong', { file: 'pages/松葉軒.md', line: 5, heading: '要約', limit: SECTION_MAX_CHARS })
    ])
  })

  it('asks every page, user.md and me.md for its # name line, and every one but me.md for a ## heading', () => {
    expect(validateDocument('user.md', '---\nupdated: 2026-09-09\n---\n## 好み\n辛さは控えめ。\n', ja)).toEqual([
      ja('memory.check.titleMissing', { file: 'user.md' })
    ])
    expect(validateDocument('user.md', '---\nupdated: 2026-09-09\n---\n# ユーザー\n東京に住む。\n', ja)).toEqual([
      ja('memory.check.noHeadings', { file: 'user.md' })
    ])
    expect(validateDocument('pages/松葉軒.md', '---\nupdated: 2026-09-09\n---\n# 松葉軒\n行きつけの店。\n', ja)).toEqual([
      ja('memory.check.noHeadings', { file: 'pages/松葉軒.md' })
    ])
    expect(validateDocument('me.md', '---\nupdated: 2026-09-09\n---\n# 私について\n落ち着いた声で話す。\n', ja)).toEqual([])
    expect(validateDocument('me.md', '# 私について\n## 私は誰か\n落ち着いた声で話す。\n', ja)).toEqual([
      ja('memory.check.frontmatterMissing', { file: 'me.md' })
    ])
  })

  it('asks a journal entry for a ## heading but not for frontmatter or a # line', () => {
    expect(validateDocument('journal/2026-09-07.md', '## 四季の話\n春は桜を勧めた。\n', ja)).toEqual([])
    expect(validateDocument('journal/2026-09-07.md', '# 2026-09-07\n春は桜を勧めた。\n', ja)).toEqual([
      ja('memory.check.noHeadings', { file: 'journal/2026-09-07.md' })
    ])
  })

  it('allows aliases only on the pages under pages/', () => {
    expect(validateDocument('user.md', '---\naliases: [本人]\nupdated: 2026-09-09\n---\n# ユーザー\n## 好み\n辛さは控えめ。\n', ja)).toEqual([
      ja('memory.check.aliasesOnlyOnPages', { file: 'user.md' })
    ])
    expect(validateDocument('me.md', '---\naliases: [アシスト]\n---\n# 私について\n## 私は誰か\n落ち着いた声で話す。\n', ja)).toEqual([
      ja('memory.check.aliasesOnlyOnPages', { file: 'me.md' })
    ])    // An empty list is refused too, as validate.py refuses it, so a page the Agent passes is never refused at the merge.
    expect(validateDocument('user.md', '---\naliases: []\nupdated: 2026-09-09\n---\n# ユーザー\n## 好み\n辛さは控えめ。\n', ja)).toEqual([
      ja('memory.check.aliasesOnlyOnPages', { file: 'user.md' })
    ])
  })

  it('refuses a heading that stands twice in one file, since a section is found by its file and heading', () => {
    const file = 'pages/大川俊介.md'
    const twice = '---\nupdated: 2026-09-20\n---\n# 大川俊介\n\n## 要約\n本人の上司。\n\n## 私の印象\n落ち着いた人に見える。\n\n## 私の印象\nくるみアレルギーがあると本人が言っていた。\n'
    expect(validateDocument(file, twice, ja)).toEqual([ja('memory.check.duplicateHeading', { file, line: 12, heading: '私の印象', first: 9 })])
    // The text above the first heading is the summary section, so a `## 要約` after it is a second one.
    const above = '---\nupdated: 2026-09-20\n---\n# 大川俊介\n本人の上司。\n\n## 要約\n打ち合わせの相手。\n'
    expect(validateDocument(file, above, ja)).toEqual([ja('memory.check.duplicateHeading', { file, line: 7, heading: '要約', first: 5 })])
  })

  it('caps the text above the first heading of a page like any other section', () => {
    const prose = '本人の行きつけのラーメン屋で、麺類の気分のときにまず名前が出る。'.repeat(30)
    expect(validateDocument('pages/松葉軒.md', `---\nupdated: 2026-09-20\n---\n# 松葉軒\n\n${prose}\n\n## 好み\n辛さは控えめ。\n`, ja)).toEqual([
      ja('memory.check.sectionTooLong', { file: 'pages/松葉軒.md', line: 6, heading: '要約', limit: SECTION_MAX_CHARS })
    ])
  })

  it('caps each document of the prompt by the tokens its body costs there, and not by the length of a section', () => {
    const shapes = {
      'me.md': (body: string) => `---\nupdated: 2026-09-20\n---\n# 私について\n\n${body}\n`,
      'user.md': (body: string) => `---\nupdated: 2026-09-20\n---\n# ユーザー\n\n## 好み\n${body}\n`
    }
    for (const [file, shape] of Object.entries(shapes)) {
      // The body grows a sentence at a time, then a character at a time, up to the last length the limit takes.
      let body = ''
      const sentence = '麺類が好きで、辛さは控えめを選ぶ。'
      while (promptSize(shape(body + sentence)).tokens <= PROMPT_DOCUMENT_MAX_TOKENS) body += sentence
      while (promptSize(shape(body + 'あ')).tokens <= PROMPT_DOCUMENT_MAX_TOKENS) body += 'あ'
      // A section far past the cap of a page's section is no problem in a document that goes whole into the prompt.
      expect([file, validateDocument(file, shape(body), ja)]).toEqual([file, []])
      const over = shape(`${body}あ`)
      const size = promptSize(over)
      expect(size.tokens).toBeGreaterThan(PROMPT_DOCUMENT_MAX_TOKENS)
      const cut = textForTokens(size, size.tokens - PROMPT_DOCUMENT_MAX_TOKENS).characters
      expect([file, validateDocument(file, over, ja)]).toEqual([
        file,
        [ja('memory.check.tooManyTokens', { file, tokens: size.tokens, limit: PROMPT_DOCUMENT_MAX_TOKENS, characters: cut })]
      ])
    }
  })

  it('estimates the tokens of a text in each conversation language near what OpenAI and Gemini count, and not under them', () => {
    // The counts were measured on 2026-10-02: o200k_base, which OpenAI's models and gpt-oss use, and the
    // countTokens of Gemini 3.8 Flash, without the token its message wrapper adds.
    for (const [language, sample] of Object.entries(TOKEN_SAMPLES)) {
      const estimate = tokenEstimate(sample.text)
      expect([language, estimate >= 0.9 * sample.o200k && estimate <= 1.35 * sample.o200k]).toEqual([language, true])
      expect([language, estimate >= 0.9 * sample.gemini]).toEqual([language, true])
    }
  })

  it('counts a document of the prompt as the prompt carries it, without its frontmatter and its name line', () => {
    const body = '## 好み\n麺類が好きで、辛さは控えめを選ぶ。'
    const page = `---\nupdated: 2026-09-20\n---\n# ユーザー\n\n${body}\n`
    expect(promptBody(page)).toBe(body)
    expect(promptSize(page).tokens).toBe(tokenEstimate(body))
    // Over by some tokens, the text to cut is that share of the document's own characters and words.
    const size = { tokens: 200, characters: 300, words: 60 }
    expect(textForTokens(size, 20)).toEqual({ characters: 30, words: 6 })
  })

  it('accepts a page under either fixed heading, and names the English one to a page written in English', () => {
    expect(validateDocument('pages/Matsubaken.md', PAGE_EN, ja)).toEqual([])
    expect(validateDocument('pages/松葉軒.md', MATSUBAKEN, ja)).toEqual([])
    expect(validateDocument('pages/Matsubaken.md', '---\nupdated: 2026-09-09\n---\n# Matsubaken\n\n## Tastes\nNot too spicy.\n', ja)).toEqual([
      ja('memory.check.firstHeading', { file: 'pages/Matsubaken.md', heading: 'Summary' })
    ])
    expect(validateDocument('pages/松葉軒.md', '---\nupdated: 2026-09-09\n---\n# 松葉軒\n\n## 好み\n辛さは控えめ。\n', ja)).toEqual([
      ja('memory.check.firstHeading', { file: 'pages/松葉軒.md', heading: '要約' })
    ])
  })

  it('accepts only a name that works in a path when a page is created', () => {
    expect(parseMemoryPageInput({ name: ' 田中さん ' })).toEqual({ name: '田中さん' })
    expect(() => parseMemoryPageInput({ name: 'a/b' })).toThrow(errorText('memory.errors.nameCharacters'))
    expect(() => parseMemoryPageInput({ name: '' })).toThrow(errorText('memory.errors.nameEmpty'))
    expect(() => parseMemoryPageInput({ kind: 'person', name: 'x' })).toThrow()
  })

  it('refuses on every OS a name Windows cannot give a file, so that the memory folder opens on either', () => {
    for (const name of ['CON', 'con', 'Nul', 'aux.txt', 'PRN.tar.gz', 'COM1', 'lpt9', 'COM¹', 'CONIN$', 'conout$.md']) {
      expect(() => parseMemoryPageInput({ name }), name).toThrow(errorText('memory.errors.nameReserved'))
    }
    expect(parseMemoryPageInput({ name: 'Dr. Tanaka' })).toEqual({ name: 'Dr. Tanaka' })
    for (const name of ['CONSOLE', 'COM0', 'LPT10', 'nul-results', 'con 1', 'Auxiliary']) {
      expect(parseMemoryPageInput({ name })).toEqual({ name })
    }
  })
})
