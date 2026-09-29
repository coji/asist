import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import { describe, expect, it } from 'vitest'
import { MESSAGES, UI_LOCALES, createTranslator, formatMessage } from '@shared/i18n'
import type { Message, PluralForms } from '@shared/i18n/message'
import { OS_MESSAGE_VARIANTS } from '@shared/i18n/os-message'

const ROOT = path.resolve(import.meta.dirname, '..')
const JAPANESE = /[぀-ヿ一-鿿]/

/**
 * Japanese that stays in the code on purpose, each with its reason. Anything else Japanese in a string would
 * show untranslated in every other language of the interface. `text` narrows an entry to the strings it
 * names, for a file that also holds text the screens show.
 */
const KEPT: Array<{ file: RegExp; text?: string; reason: string }> = [
  { file: /^src\/renderer\/src\/demo\//, reason: 'sample data and the developer-facing frame of the demo' },
  { file: /\/ConversationPage\.tsx$/, text: '声のテストです', reason: 'the sentence the bundled voice samples say' },
  { file: /^src\/main\/ipc\.ts$/, text: '音声のテストです', reason: 'the sentence the speech test says, in the language of the conversation' },
  { file: /^src\/main\/services\/brain\//, reason: 'prompts, tool descriptions and tool results, written for the model' },
  { file: /^src\/main\/services\/(bridge-plan|live\/index|live\/gpt-live|live\/gemini-live)\.ts$/, reason: 'prompts and bracketed notes sent to a model' },
  { file: /^src\/main\/services\/llm\/adapter\.ts$/, text: '^エラー:', reason: 'the prefix of a failed tool result, read by the model' },
  { file: /^src\/shared\/(tool-registry|tool-round|turn-recovery|persona|panel-catalog|map-embed|weather|calendar|memory-injection|conversation-markers|job-workspace)\.ts$/, reason: 'prompts, tool schemas and conversation markers, written for the model' },
  { file: /^src\/main\/services\/weather\/(locations|open-meteo)\.ts$/, reason: 'instructions returned to the model when a place is unknown or ambiguous' },
  { file: /^src\/main\/services\/(agent|mail-service)\.ts$/, text: '再起動前のAgent|取り込みで衝突|ユーザーが却下|\\(続き\\)|下書きにしました|件名なし', reason: 'job summaries and draft summaries that the model reads' },
  { file: /^src\/shared\/job-recovery\.ts$/, reason: 'job summaries that the model reads' },
  { file: /^src\/shared\/tasks\.ts$/, text: '^(やること|進行中|完了)$', reason: 'the status names in the task summary the agent reads' },
  { file: /^src\/main\/services\/git\.ts$/, text: '以下省略', reason: 'a note inside a patch that the model also reads' },
  { file: /^src\/(main\/services\/(memory|memory-store|memory-curation)|shared\/(memory-page|memory-curation))\.ts$/, reason: 'the format of the memory files, their commit messages and the curation prompt' },
  { file: /^src\/shared\/aizuchi-bank\.ts$/, reason: 'what the assistant says, which is data of the conversation language' },
  { file: /^src\/shared\/conversation-locale\.ts$/, text: '^[日月火水木金土]$', reason: 'the weekday names a date written for the model carries' },
  { file: /^src\/main\/services\/(selftest|panel-fetchers|weather\/parsers)\.ts$/, reason: 'test utterances, Japanese place names and the weather words of the JMA data' },
  { file: /^src\/shared\/credits\.ts$/, text: '気象庁|国土地理院', reason: 'the source of the weather and the municipality data, named as their terms of use ask' }
]

/**
 * Text written straight into the markup that is the same in every language, which is the only kind allowed
 * there: the product and its section titles, the names of models and CLIs, units, keys and protocol words.
 * A word that a translator would render differently belongs in the dictionary instead.
 */
const SAME_IN_EVERY_LANGUAGE = new Set([
  'ASIST', 'AGENT JOBS', 'CALENDAR', 'MAIL', 'MEMORY', 'NOTES', 'SETTINGS', 'TASKS', '· FOCUS', '▲ YOU', 'METRIC',
  'LLM', 'ASR', 'TTS', 'AGENT', 'Agent', 'CPU', 'GMT', 'Cc', 'Enter', 'exit', 'push', 'Stars', 'Forks', 'Issues', 'ms', 'GB',
  'Codex', 'Claude Code',
  '/Users/you/Desktop'
])
const READ_ALOUD_ATTRIBUTES = new Set(['aria-label', 'title', 'placeholder', 'alt', 'label'])

/** The text and the text-bearing attributes written as literals in the markup of one file. */
function markupLiterals(file: string): Array<{ line: number; text: string }> {
  const ast = parse(readFileSync(path.join(ROOT, file), 'utf8'), { sourceType: 'module', plugins: ['typescript', 'jsx', 'importAttributes'] })
  const found: Array<{ line: number; text: string }> = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    const current = node as { type?: string; value?: unknown; name?: { name?: string }; loc?: { start: { line: number } } }
    const line = current.loc?.start.line ?? 0
    if (current.type === 'JSXText') found.push({ line, text: String(current.value).trim() })
    const literal = current.value as { type?: string; value?: string } | undefined
    if (current.type === 'JSXAttribute' && READ_ALOUD_ATTRIBUTES.has(current.name?.name ?? '') && literal?.type === 'StringLiteral') found.push({ line, text: String(literal.value) })
    for (const [key, value] of Object.entries(current)) if (key !== 'loc' && !key.endsWith('Comments')) visit(value)
  }
  visit(ast.program)
  return found.filter((entry) => /\p{L}{2,}/u.test(entry.text))
}

/** The calls that write a message in one language, which a thrown error must not be made of. */
const IN_ONE_LANGUAGE = new Set(['t', 'translate', 'tConversation', 'formatMessage', 'displayError', 'errorMessage', 'errorMessageIn'])

/**
 * The lines of one file that throw an error made of a sentence in one language. The screen writes an error
 * from the key errorText puts in its message, in the language of the interface at the time, and the log
 * keeps it in English; a sentence already written in one language gives neither.
 */
function errorsInOneLanguage(file: string): number[] {
  const ast = parse(readFileSync(path.join(ROOT, file), 'utf8'), { sourceType: 'module', plugins: ['typescript', 'jsx', 'importAttributes'] })
  const found: number[] = []
  type Node = { type?: string; callee?: { type?: string; name?: string }; arguments?: Node[]; loc?: { start: { line: number } } }
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    const current = node as Node
    const message = current.arguments?.[0]
    if (
      current.type === 'NewExpression' &&
      /Error$/.test(current.callee?.name ?? '') &&
      message?.type === 'CallExpression' &&
      IN_ONE_LANGUAGE.has(message.callee?.name ?? '')
    )
      found.push(current.loc?.start.line ?? 0)
    for (const [key, value] of Object.entries(current)) if (key !== 'loc' && !key.endsWith('Comments')) visit(value)
  }
  visit(ast.program)
  return found
}

function leaves(node: unknown, prefix = ''): Array<[string, Message]> {
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    'ja-JP' in (value as object) ? [[`${prefix}${key}`, value as Message] as [string, Message]] : leaves(value, `${prefix}${key}.`)
  )
}
const forms = (form: string | PluralForms): string[] => (typeof form === 'string' ? [form] : Object.values(form))
const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

function sourceFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => /\.(ts|tsx)$/.test(file) && !file.startsWith('src/shared/i18n/'))
}

function literals(file: string): { strings: string[]; templates: RegExp[]; japanese: Array<{ line: number; text: string }> } {
  const ast = parse(readFileSync(path.join(ROOT, file), 'utf8'), { sourceType: 'module', plugins: ['typescript', 'jsx', 'importAttributes'] })
  const found = { strings: [] as string[], templates: [] as RegExp[], japanese: [] as Array<{ line: number; text: string }> }
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    const current = node as { type?: string; value?: unknown; quasis?: Array<{ value: { cooked: string } }>; loc?: { start: { line: number } } }
    let text: string | null = null
    if (current.type === 'StringLiteral' || current.type === 'JSXText') {
      text = String(current.value)
      found.strings.push(text)
    } else if (current.type === 'TemplateLiteral' && current.quasis) {
      const parts = current.quasis.map((quasi) => quasi.value.cooked)
      text = parts.join('')
      // `t(\`a.${name}.label\`)` uses every key the pattern can name. Only a template that starts inside a group
      // of the dictionary counts, so that an unrelated `${a}.${b}` elsewhere does not hide an unused key.
      if (Object.keys(MESSAGES).some((group) => parts[0].startsWith(`${group}.`))) found.templates.push(new RegExp(`^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\w]+')}$`))
    }
    if (text !== null && JAPANESE.test(text)) found.japanese.push({ line: current.loc?.start.line ?? 0, text: text.trim().slice(0, 60) })
    for (const [key, value] of Object.entries(current)) if (key !== 'loc' && !key.endsWith('Comments')) visit(value)
  }
  visit(ast.program)
  return found
}

describe('formatMessage', () => {
  it('fills every placeholder in, including one that appears twice', () => {
    const message = { 'ja-JP': '{name} を {name} に', 'en-US': '{name} to {name}' } as Message
    expect(formatMessage(message, 'en-US', { name: 'a' })).toBe('a to a')
  })

  it('chooses the plural form by the rules of the language, and the language without plurals uses its single form', () => {
    const message = { 'ja-JP': { other: '{count} 件ほど' }, 'en-US': { one: '{count} more', other: '{count} more items' } } as Message
    expect(formatMessage(message, 'en-US', { count: 1 })).toBe('1 more')
    expect(formatMessage(message, 'en-US', { count: 3 })).toBe('3 more items')
    expect(formatMessage(message, 'ja-JP', { count: 1 })).toBe('1 件ほど')
  })

  it('reads a nested key in the chosen language', () => {
    expect(createTranslator('en-US')('settingsVoice.speech.engineMissing.macos', { engine: 'VOICEVOX' })).toContain('VOICEVOX')
  })
})

describe('the dictionary', () => {
  const all = leaves(MESSAGES)

  // Every language a message holds is checked, including one that is still being written and cannot be chosen yet.
  const localesOf = (message: Message): string[] => Object.keys(message)
  const textsOf = (message: Message, locale: string): string[] => forms((message as Record<string, string | PluralForms>)[locale])

  it('names the same placeholders in every language and every plural form, so no value is dropped or left as braces', () => {
    const mismatched = all.flatMap(([key, message]) => {
      const expected = placeholders(forms(message['ja-JP'])[0])
      return localesOf(message).flatMap((locale) =>
        textsOf(message, locale).filter((text) => placeholders(text).join() !== expected.join()).map((text) => `${key} [${locale}]: ${text}`)
      )
    })
    expect(mismatched).toEqual([])
  })

  it('has no empty string in any language', () => {
    expect(all.flatMap(([key, message]) => localesOf(message).filter((locale) => textsOf(message, locale).some((text) => !text.trim())).map((locale) => `${key} [${locale}]`))).toEqual([])
  })

  it('gives a message with plural forms those forms in every language, and only categories the language has', () => {
    const wrong = all.flatMap(([key, message]) =>
      localesOf(message).flatMap((locale) => {
        const form = (message as Record<string, string | PluralForms>)[locale]
        if ((typeof form === 'string') !== (typeof message['ja-JP'] === 'string')) return [`${key} [${locale}]: plural forms in one language and a plain string in another`]
        if (typeof form === 'string') return []
        const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories
        return Object.keys(form).filter((category) => !categories.includes(category as Intl.LDMLPluralRule)).map((category) => `${key} [${locale}]: ${category}`)
      })
    )
    expect(wrong).toEqual([])
  })

  // A sentence that tells the user to press a button or open a page names it in 「」 in Japanese. When the
  // quoted words are the Japanese of another message, that button or page is what the sentence points at,
  // and every language has to name it as its own screen shows it, or the sentence sends the user to a
  // label that is not there. Quoted words that match no message, such as an example of what to say, are
  // not looked at.
  it('names a button or a page that a sentence points at exactly as that language shows it', () => {
    const all = leaves(MESSAGES)
    const byKey = new Map(all)
    const byJapanese = new Map<string, string[]>()
    for (const [key, message] of all) for (const form of forms(message['ja-JP'])) byJapanese.set(form, [...(byJapanese.get(form) ?? []), key])
    const astray: string[] = []
    for (const [key, message] of all) {
      for (const [, quoted] of forms(message['ja-JP']).flatMap((form) => [...form.matchAll(/「([^」{}]+)」/g)])) {
        const labels = (byJapanese.get(quoted) ?? []).filter((other) => other !== key)
        if (labels.length === 0) continue
        for (const locale of UI_LOCALES.filter((one) => one !== 'ja-JP')) {
          const sentence = forms(message[locale]).join('\n')
          if (!labels.some((label) => forms(byKey.get(label)![locale]).some((shown) => sentence.includes(shown)))) astray.push(`${locale} ${key}: 「${quoted}」`)
        }
      }
    }
    expect(astray).toEqual([])
  })

  // Parsing every file under src took 315 ms when this file ran alone, but 5786 ms when `npm test` ran while
  // `npm run demo:fit` kept three headless Chromes busy (10-core Mac, 2026-09-24), past vitest's default of
  // 5000 ms. The explicit timeout keeps a busy machine from failing a test whose assertion holds.
  it('holds no message that the source no longer uses', { timeout: 30_000 }, () => {
    const used = sourceFiles().map(literals)
    const strings = new Set(used.flatMap((file) => file.strings))
    const templates = used.flatMap((file) => file.templates)
    // A message written once per OS is used through osMessageKey, which the source names by the key in front
    // of `.macos` and `.windows`.
    const osVariant = new RegExp(`\\.(${Object.keys(OS_MESSAGE_VARIANTS).join('|')})$`)
    const isUsed = (key: string): boolean => strings.has(key) || templates.some((pattern) => pattern.test(key))
    const unused = all.map(([key]) => key).filter((key) => !isUsed(key) && !(osVariant.test(key) && isUsed(key.replace(osVariant, ''))))
    expect(unused).toEqual([])
  })

  it('writes a message that names a part of the OS for every OS and nothing else', () => {
    const variants = Object.keys(OS_MESSAGE_VARIANTS).sort()
    const groups = (node: unknown, prefix: string): Array<[string, string[]]> =>
      'ja-JP' in (node as object)
        ? []
        : Object.entries(node as Record<string, unknown>).flatMap(([key, child]) => [
            ...(variants.some((os) => os in (child as object)) ? [[`${prefix}${key}`, Object.keys(child as object).sort()] as [string, string[]]] : []),
            ...groups(child, `${prefix}${key}.`)
          ])
    const incomplete = groups(MESSAGES, '').filter(([, children]) => children.join() !== variants.join())
    expect(incomplete).toEqual([])
  })

  // This parses every file under src as well: 177 ms alone and 2476 ms under the same load on the same day.
  it('finds no Japanese string outside the dictionary, thrown errors included, except the ones kept for a stated reason', { timeout: 30_000 }, () => {
    const left = sourceFiles().flatMap((file) =>
      literals(file)
        .japanese.filter(({ text }) => !KEPT.some((kept) => kept.file.test(file) && (!kept.text || new RegExp(kept.text).test(text))))
        .map(({ line, text }) => `${file}:${line}: ${text}`)
    )
    expect(left).toEqual([])
  })
})

describe('errors', () => {
  it('throws no error made of a sentence in one language', { timeout: 30_000 }, () => {
    const thrown = sourceFiles().flatMap((file) => errorsInOneLanguage(file).map((line) => `${file}:${line}`))
    expect(thrown).toEqual([])
  })
})

describe('markup', () => {
  it('writes no word into the markup of a screen, in any language, unless it is the same in every language', () => {
    const files = sourceFiles().filter((file) => file.endsWith('.tsx') && file.startsWith('src/renderer/') && !file.startsWith('src/renderer/src/demo/'))
    const written = files.flatMap((file) => markupLiterals(file).filter((entry) => !SAME_IN_EVERY_LANGUAGE.has(entry.text)).map((entry) => `${file}:${entry.line} ${entry.text}`))
    expect(written).toEqual([])
  })
})
