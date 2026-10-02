import { describe, expect, it } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { foldInstruction, type PromptDocuments } from '@shared/instruction-fold'
import { validateDocument } from '@shared/memory-page'

const ja = createTranslator('ja-JP')

const TODAY = '2026-10-02'

/** What validateDocument finds in each document the fold wrote. */
const findings = (folded: PromptDocuments): Record<string, string[]> => ({
  'me.md': folded.me === null ? [] : validateDocument('me.md', folded.me, ja),
  'user.md': folded.user === null ? [] : validateDocument('user.md', folded.user, ja)
})

describe('folding instruction.md into me.md and user.md', () => {
  it('moves what an instruction.md held into me.md and user.md word for word, its section about the assistant into me.md', () => {
    const instruction = '# いつも覚えておくこと\n\n## この人について\n三鷹に住んでいる。\n\n## 私について\n落ち着いて短く話す。\n\n## 頼まれていること\n「一言で」と言われたら一言で返す。\n'
    const me = '---\nupdated: 2026-09-20\n---\n# 私について\n\n## 私は誰か\n声の相棒。\n'
    const user = '---\nupdated: 2026-09-20\n---\n# ユーザー\n\n## 属性\n猫と暮らしている。\n\n## ASIST への期待\n答えは短く。\n'
    const folded = foldInstruction(instruction, { me, user }, TODAY)
    expect(folded.me).toBe(`${me}\n## 私について\n落ち着いて短く話す。\n`)
    expect(folded.user).toBe(`${user}\n## この人について\n三鷹に住んでいる。\n\n## 頼まれていること\n「一言で」と言われたら一言で返す。\n`)
    expect(findings(folded)).toEqual({ 'me.md': [], 'user.md': [] })
  })

  it('adds a moved section to the section of the same heading, so that no heading stands twice, and starts a document that did not exist', () => {
    const instruction = '# Always keep in mind\n\n## What they expect of ASIST\nKeep it to one word when asked for one.\n\n## About me\nA calm voice.\n'
    const user = '---\nupdated: 2026-09-20\n---\n# The user\n\n## What they expect of ASIST\nShort answers.\n\n## Habits\nUp at seven.\n'
    const folded = foldInstruction(instruction, { me: null, user }, TODAY)
    expect(folded.user).toBe(
      '---\nupdated: 2026-09-20\n---\n# The user\n\n## What they expect of ASIST\nShort answers.\n\nKeep it to one word when asked for one.\n\n## Habits\nUp at seven.\n'
    )
    expect(folded.me).toBe('---\nupdated: 2026-10-02\n---\n# About me\n\n## About me\nA calm voice.\n')
    expect(findings(folded)).toEqual({ 'me.md': [], 'user.md': [] })
    // An instruction.md without a section about the assistant leaves me.md as it was.
    expect(foldInstruction('# いつも覚えておくこと\n\n## 頼まれていること\n短く話す。\n', { me: null, user: null }, TODAY).me).toBeNull()
  })

  it('keeps the blank lines, the line breaks, the `# ` lines and the fenced code of a section, and puts the text above the first heading into the summary of user.md', () => {
    const instruction =
      '# いつも覚えておくこと\n\nこの要約は手で書いた前書き。\n\n## この人について\n三鷹に住んでいる。\n\n二段落目: 猫を飼っている。  \n二行目。\n\n# 追記\n手で書いた追記。\n\n```\n## コードの中\n```\n\n## 私について\n落ち着いて短く話す。\n'
    const user = '---\nupdated: 2026-09-20\n---\n# ユーザー\n\nこれは前書き。\n\n## 属性\n猫と暮らしている。\n'
    const me = '---\nupdated: 2026-09-20\n---\n# 私について\n\n声の相棒。\n'
    const folded = foldInstruction(instruction, { me, user }, TODAY)
    expect(folded.user).toBe(
      '---\nupdated: 2026-09-20\n---\n# ユーザー\n\nこれは前書き。\n\nこの要約は手で書いた前書き。\n\n## 属性\n猫と暮らしている。\n\n' +
        '## この人について\n三鷹に住んでいる。\n\n二段落目: 猫を飼っている。  \n二行目。\n\n# 追記\n手で書いた追記。\n\n```\n## コードの中\n```\n'
    )
    expect(folded.me).toBe(`${me}\n## 私について\n落ち着いて短く話す。\n`)
    expect(findings(folded)).toEqual({ 'me.md': [], 'user.md': [] })
  })

  it('puts a summary, whether written above the first heading or under its heading, into the one summary user.md has', () => {
    const instruction = '# いつも覚えておくこと\n\n手で書いた前書き。\n\n## 要約\n短く話すのが好き。\n\n## この人について\n三鷹に住んでいる。\n'
    const headed = '---\nupdated: 2026-09-20\n---\n# ユーザー\n\n## 要約\n三鷹の人。\n\n## 属性\n猫と暮らしている。\n'
    const intoHeading = foldInstruction(instruction, { me: null, user: headed }, TODAY)
    expect(intoHeading.user).toBe(
      '---\nupdated: 2026-09-20\n---\n# ユーザー\n\n## 要約\n三鷹の人。\n\n手で書いた前書き。\n\n短く話すのが好き。\n\n## 属性\n猫と暮らしている。\n\n## この人について\n三鷹に住んでいる。\n'
    )
    const above = '---\nupdated: 2026-09-20\n---\n# ユーザー\n三鷹の人。\n\n## 属性\n猫と暮らしている。\n'
    const intoText = foldInstruction(instruction, { me: null, user: above }, TODAY)
    expect(intoText.user).toBe(
      '---\nupdated: 2026-09-20\n---\n# ユーザー\n三鷹の人。\n\n手で書いた前書き。\n\n短く話すのが好き。\n\n## 属性\n猫と暮らしている。\n\n## この人について\n三鷹に住んでいる。\n'
    )
    expect(findings(intoHeading)).toEqual({ 'me.md': [], 'user.md': [] })
    expect(findings(intoText)).toEqual({ 'me.md': [], 'user.md': [] })
  })

  it('starts a user.md that is empty or holds only whitespace as one that does not exist, and keeps the line endings of one written with CRLF', () => {
    const instruction = '# いつも覚えておくこと\n\n## この人について\n三鷹に住んでいる。\n'
    const started = '---\nupdated: 2026-10-02\n---\n# ユーザー\n\n## この人について\n三鷹に住んでいる。\n'
    for (const user of [null, '', ' \n\n']) {
      const folded = foldInstruction(instruction, { me: null, user }, TODAY)
      expect([user, folded.user]).toEqual([user, started])
      expect(findings(folded)).toEqual({ 'me.md': [], 'user.md': [] })
    }
    const crlf = '---\r\nupdated: 2026-09-20\r\n---\r\n# ユーザー\r\n\r\n## 属性\r\n猫と暮らしている。\r\n'
    expect(foldInstruction(instruction, { me: null, user: crlf }, TODAY).user).toBe(`${crlf}\r\n## この人について\r\n三鷹に住んでいる。\r\n`)
  })

  it('changes nothing when it folds the same instruction again, as after a fold that stopped before its commit, whole or halfway', () => {
    const cases: Array<[string, PromptDocuments]> = [
      [
        '# いつも覚えておくこと\n\nこの要約は手で書いた前書き。\n\n## この人について\n三鷹に住んでいる。\n\n二段落目。  \n二行目。\n\n```\n## コードの中\n```\n\n## 私について\n落ち着いて短く話す。\n',
        { me: '---\nupdated: 2026-09-20\n---\n# 私について\n\n声の相棒。\n', user: '---\nupdated: 2026-09-20\n---\n# ユーザー\n\n## 属性\n猫と暮らしている。\n' }
      ],
      [
        '# Always keep in mind\n\n## What they expect of ASIST\nKeep it to one word when asked for one.\n\n## About me\nA calm voice.\n',
        { me: null, user: '---\nupdated: 2026-09-20\n---\n# The user\n\n## What they expect of ASIST\nShort answers.\n\n## Habits\nUp at seven.\n' }
      ],
      ['# いつも覚えておくこと\n\n手で書いた前書き。\n\n## 要約\n短く話すのが好き。\n', { me: null, user: '---\nupdated: 2026-09-20\n---\n# ユーザー\n\n## 要約\n三鷹の人。\n' }]
    ]
    for (const [instruction, documents] of cases) {
      const once = foldInstruction(instruction, documents, TODAY)
      expect(foldInstruction(instruction, once, '2026-10-03')).toEqual(once)
      // A stop after me.md was written and before user.md was.
      expect(foldInstruction(instruction, { me: once.me, user: documents.user }, '2026-10-03')).toEqual(once)
    }
  })
})
