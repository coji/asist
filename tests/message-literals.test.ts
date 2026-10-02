import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import { expect, it } from 'vitest'
import { MESSAGES } from '@shared/i18n'
import type { Message, Messages } from '@shared/i18n/message'

/**
 * A test that writes out the Japanese text of a dictionary message fails when the wording changes, although
 * nothing is broken. Tests read a message through `createTranslator('ja-JP')` instead. This check finds the
 * literals that equal what a message produces, so that a rewording cannot break an unrelated test again.
 */

const ROOT = path.resolve(import.meta.dirname, '..')
const JAPANESE = /[぀-ヿ一-鿿]/
const SELF = 'tests/message-literals.test.ts'

/**
 * Literals that equal a message but come from somewhere other than the dictionary, each with its reason. A
 * literal that is only test data is rewritten so that it no longer equals a message instead of being listed.
 */
const NOT_MESSAGES: Array<{ file: RegExp; text: string; reason: string }> = [
  ...['ユーザー', '私について', 'いつも覚えておくこと'].map((text) => ({
    file: /^tests\/memory-(page|store|service|index)\.test\.ts$/,
    text,
    reason: 'a title of a memory file, which src/shared/memory-page.ts writes as data the model reads, not the label the memory screen shows'
  })),
  {
    file: /^tests\/(brain-tools|weather|weather-service)\.test\.ts$/,
    text: '東京',
    reason: 'a place name: the default city of panel-catalog.ts, a name the municipality table does not resolve, and the station name in the JMA data'
  },
  ...['今週', '終日', '期間'].map((text) => ({ file: /^tests\/calendar-(service|tools)\.test\.ts$/, text, reason: 'the words src/shared/calendar.ts writes for the model' })),
  { file: /^tests\/llm-(openai|cerebras)\.test\.ts$/, text: 'エラー: HTTP 503', reason: 'a failed tool result, which conversation-markers.ts prefixes with its own `エラー:` for the model' },
  { file: /^tests\/brain-turn\.test\.ts$/, text: '相槌', reason: 'a word the request to the model must not contain' },
  ...['サポートの応答時間', '料金', 'メモ'].map((text) => ({ file: /^tests\/viewer-(docx|xlsx)\.test\.tsx$/, text, reason: 'text inside the demo docx and xlsx files the viewer renders' })),
  { file: /^tests\/listening-aizuchi\.test\.ts$/, text: 'テストを書いてから', reason: 'an utterance that ends in the conjunctive から under test, which any text ending in から shares with `{box}から`' }
]

type Pattern = { key: string; matches: (text: string) => boolean }

function patterns(node: Messages, prefix = ''): Pattern[] {
  return Object.entries(node).flatMap(([key, value]) => {
    if (!('ja-JP' in value)) return patterns(value as Messages, `${prefix}${key}.`)
    const source = (value as Message)['ja-JP']
    return (typeof source === 'string' ? [source] : Object.values(source)).flatMap((text) => {
      // A message of one fixed character, such as a unit or a mark, is as likely to be data as a message. A message
      // whose fixed text has no Japanese, such as `{date} · {phase}`, only joins values, and every Japanese literal
      // with a `·` in it would match it.
      const fixed = text.replace(/\{\w+\}/g, '')
      if (fixed.length < 2 || !JAPANESE.test(fixed)) return []
      if (!/\{\w+\}/.test(text)) return [{ key: `${prefix}${key}`, matches: (literal: string) => literal === text }]
      const regex = new RegExp(`^${text.split(/\{\w+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]+')}$`)
      return [{ key: `${prefix}${key}`, matches: (literal: string) => regex.test(literal) }]
    })
  })
}

function japaneseLiterals(file: string): Array<{ line: number; text: string }> {
  const ast = parse(readFileSync(path.join(ROOT, file), 'utf8'), { sourceType: 'module', plugins: ['typescript', 'jsx', 'importAttributes'] })
  const found: Array<{ line: number; text: string }> = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    const current = node as { type?: string; value?: unknown; expressions?: unknown[]; quasis?: Array<{ value: { cooked: string } }>; loc?: { start: { line: number } } }
    const line = current.loc?.start.line ?? 0
    if (current.type === 'StringLiteral' && JAPANESE.test(String(current.value))) found.push({ line, text: String(current.value) })
    if (current.type === 'TemplateLiteral' && current.expressions?.length === 0 && current.quasis) {
      const text = current.quasis.map((quasi) => quasi.value.cooked).join('')
      if (JAPANESE.test(text)) found.push({ line, text })
    }
    for (const [key, value] of Object.entries(current)) if (key !== 'loc' && !key.endsWith('Comments')) visit(value)
  }
  visit(ast.program)
  return found
}

// Parsing every test file took 340 ms when this file ran alone, but 7148 ms when `npm test` ran while
// `npm run demo:fit` kept three headless Chromes busy (10-core Mac, 2026-09-24), past vitest's default of
// 5000 ms. The explicit timeout keeps a busy machine from failing a test whose assertion holds.
it('reads every message of the interface through the translator, so that rewording a message cannot fail an unrelated test', { timeout: 30_000 }, () => {
  const all = patterns(MESSAGES as unknown as Messages)
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'tests'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => /\.tsx?$/.test(file) && file !== SELF)
  const written = files.flatMap((file) =>
    japaneseLiterals(file)
      .filter((literal) => !NOT_MESSAGES.some((entry) => entry.file.test(file) && entry.text === literal.text))
      .flatMap((literal) =>
      all.filter((pattern) => pattern.matches(literal.text)).map((pattern) => `${file}:${literal.line} ${JSON.stringify(literal.text)} is t('${pattern.key}')`)
    )
  )
  expect(written).toEqual([])
})
