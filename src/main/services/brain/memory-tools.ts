import type { MemoryUnit } from '@shared/ipc'
import type { PromptLanguage, PromptText } from '@shared/conversation-locale'
import { LOCAL_TIMEOUT_MS, ToolError, bilingual, type ToolDefinition } from '@shared/tool-registry'
import * as memory from '../memory'
import type { ToolContext } from './tools'

/**
 * The memory tool, recall. Writing the memory belongs to the curation Agent, and deleting it to the
 * memory screen, so the conversation only reads.
 */

type Def = ToolDefinition<ToolContext>

const PANEL_RESULT_MAX = 3000

/** The shape returned to the model: the page name and heading, without the internal line numbers or vectors. */
const publicMemory = (u: MemoryUnit, language: PromptLanguage): Record<string, unknown> => ({
  id: u.id,
  page: u.kind === 'journal' ? TEXTS.journalPage(u.date ?? '')[language] : u.page,
  ...(u.heading ? { heading: u.heading } : {}),
  kind: u.kind,
  text: u.text,
  ...(u.date ? { date: u.date } : {}),
})

export function memoryTools(language: PromptLanguage): Def[] {
  return [
    {
      name: 'recall',
      description: {
        ja: [
          '記憶(人や場所や話題のページ、自分が書いた日ごとの日記)を検索して思い出す。思い出す手段はほかに三つあり、まずそれで足りるか見る: 直近の会話(今日と昨日の話は履歴にある)、system の記憶(「私について」「ユーザー」は丸ごと載っているので、recall では引かない)、user メッセージの「[記憶]」の注記(発話に出た名前や話題で自動的に引いたもの)。この三つに無いときだけ recall を使う。',
          '使う場面: 発話に名前が出ていない指示語(「この前言ってたあの店」「例の件」)を、文脈から「ラーメン屋」「提案書」のように言い換えて引くとき。数日前より前の話を引くとき(日記は日付で引ける。例: 2026-09-01)。言う前に確かめたいとき。注記に出た以外の見出し(好み、経緯)や日記を読みたいとき。',
          '手順: 1ターンに1〜2回まで。呼ぶ前に一文つなぐ。query は名前、別名、日付、話題の語。ページ名か別名が当たればそのページの要約が先頭に来る。当たらなければ言い換えて一度だけ引き直し、それでも無ければ「覚えていない」と正直に言う。',
          '結果: { hits: [{ id, page, heading, kind, text, date }], count }。kind は section(ページの見出しの一つ) / journal(その日に自分が一人称で書いた日記)。確からしさは本文の言い回しで分かる(言い切りは本人が言ったこと、「〜らしい」は推測)。過去の経緯は「〜までは」と書かれた文と日記にある。',
          'やらない場合: 直近の会話にあること、system の記憶や注記にあること、現在時刻、計算や翻訳、画面にあること。足りなければ run_agent_task へ昇格する。'
        ].join('\n'),
        en: [
          'Searches the memories and recalls something: the pages about people, places and subjects, and the daily diary you write yourself. Three other ways of remembering come first, so check them before reaching for this one: the recent conversation, which holds today and yesterday; the memory in the system prompt, where about me and the user stand whole and recall does not look; and the bracketed memory notes attached to the user message, pulled automatically from the names and subjects they said. Use recall only when none of the three has it.',
          'When to use it: to look something up that the user pointed at without naming it, such as "that place you mentioned" or "that thing", after putting the subject into words yourself from the conversation. To reach back further than the last few days; the diary can be looked up by date, for example 2026-09-01. To make sure of something before you say it. To read a heading, such as a preference or how something came about, or a diary entry that the notes did not carry.',
          'Steps: once or twice in a turn at most, with one filler sentence before you call it. query is a name, an alias, a date or a word for the subject. When a page name or an alias matches, that page\'s summary comes first. When nothing matches, put it in other words and try once more, and if it is still not there, say honestly that you do not remember.',
          'Result: { hits: [{ id, page, heading, kind, text, date }], count }. kind is section, one heading of a page, or journal, the diary you wrote that day in the first person. How sure a line is shows in its wording: a plain statement is what the user said, a hedged one is a guess. How things used to be is in the sentences saying what held until when, and in the diary.',
          'Do not use it for: anything in the recent conversation, anything in the memory of the system prompt or in the notes, the current time, arithmetic or translation, anything on screen. When it is not enough, hand the work to run_agent_task.'
        ].join('\n')
      },
      usage: {
        ja: '直近の会話にも system の記憶にも注記にも無いことを思い出す。名前の無い指示語は文脈で言い換えて引く。言う前に確かめる。1ターンに1〜2回、呼ぶ前に一文つなぐ',
        en: 'Recall something that is in neither the recent conversation, the memory of the system prompt nor the notes. Put an unnamed reference into words yourself before looking it up. Make sure before you say it. Once or twice a turn, with one filler sentence first.'
      },
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: bilingual({
              ja: '名前、別名、日付、話題の語(例: 松葉軒、田中部長、2026-09-01、提案書の締め切り)。指示語は文脈で言い換えてから書く',
              en: 'A name, an alias, a date or a word for the subject, such as a shop\'s name, a person\'s name, 2026-09-01, or the deadline of a proposal. Put an unnamed reference into words from the conversation first.'
            })
          }
        },
        required: ['query'],
        additionalProperties: false
      },
      parallel: true,
      timeoutMs: LOCAL_TIMEOUT_MS,
      maxResultChars: PANEL_RESULT_MAX,
      run: async (input, _ctx, signal) => {
        const query = String(input.query ?? '').trim()
        if (!query) throw new ToolError(TEXTS.emptyQuery)
        const hits = await memory.search(query, { limit: 5 }, signal)
        return { hits: hits.map((h) => publicMemory(h.record, language)), count: hits.length }
      }
    }
  ]
}

/** What this file says to the model, in both prompt languages. */
const TEXTS = {
  emptyQuery: {
    ja: 'queryが空。探したい内容を書いて呼び直すこと。',
    en: 'query is empty. Write what to look for and call again.'
  },
  journalPage: (date: string): PromptText => ({ ja: `${date}の日記`, en: `the diary of ${date}` })
} as const
