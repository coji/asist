import type { JsonSchema } from '@shared/conversation'
import { calendarChangeSchema } from '@shared/calendar'
import type { ConversationLocale, PromptText } from '@shared/conversation-locale'
import { ToolError, inputJsonSchema, type ToolDefinition } from '@shared/tool-registry'
import { changeCalendar } from '../calendar'
import { detail } from './tool-error-text'
import type { ToolContext } from './tools'

/**
 * The calendar tools. The wording of the dates and of the range comes from shared/calendar, which
 * writes them in the language of the conversation.
 */

/** What this file says to the model, in both prompt languages. */
const TEXTS = {
  changeFailed: (reason: string): PromptText => ({
    ja: `予定を変更できません: ${reason}。入力を直して呼び直すこと。`,
    en: `The event could not be changed: ${reason}. Correct the input and call again.`
  })
} as const

export function calendarTools(locale: ConversationLocale): ToolDefinition<ToolContext>[] {
  return [
    {
      name: 'change_calendar',
      description: {
        ja: '通常の予定を追加・変更・削除する。実行前に必ずネイティブ確認画面を表示し、ユーザーのクリック承認後に保存する。createは設定の保存先、update/deleteは show_calendar で得た events[].id の元カレンダーを使う。updateは変更後の全フィールドを指定し、未変更の値は show_calendar の結果(start/end/timeZone/allDay/location/notes)から写す。繰り返しと招待付き予定の変更・削除には未対応。日時・タイムゾーンが不明なら聞き返す。終日は終了日の翌日0時をendに指定。失敗や時間切れ時は自動再実行しない。Google同期完了を断言しない。',
        en: 'Adds, changes or deletes an ordinary event. A native confirmation window always comes up first and nothing is saved until the user clicks it through. create writes to the calendar chosen in the settings; update and delete act on the calendar the event came from, found through events[].id in show_calendar. update takes every field as it should end up, so copy the unchanged values (start, end, timeZone, allDay, location, notes) from the result of show_calendar. Changing or deleting a repeating event, or one with invitees, is not supported. Ask again when the date, the time or the time zone is unclear. For an all-day event, end is midnight of the day after the last day. Never retry by yourself after a failure or a timeout, and never state that a sync with Google has finished.'
      },
      usage: {
        ja: '予定の追加・変更・削除を明示的に頼まれたとき。変更・削除は先に show_calendar で対象の id を得て、候補が複数ならユーザーに聞く。「確認画面の内容を確認してください」と伝えてから呼ぶ。保存済みかキャンセルかは結果に従う。',
        en: 'When the user explicitly asks to add, change or delete an event. For a change or a deletion, get the id with show_calendar first, and ask the user when more than one event matches. Tell them to look over the confirmation window before you call it, and say whether it was saved or cancelled according to the result.'
      },
      // Some providers reject a schema whose top level is not an object, so the discriminated union is validated again at run time.
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['create', 'update', 'delete'] },
          eventId: { type: 'string' },
          event: (inputJsonSchema(calendarChangeSchema.options[0]).properties as Record<string, unknown>).event
        },
        required: ['operation'],
        additionalProperties: false
      } as JsonSchema,
      parallel: false,
      timeoutMs: 300_000,
      maxResultChars: 3000,
      run: async (input, _ctx, signal) => {
        try {
          return await changeCalendar(input, signal)
        } catch (err) {
          throw new ToolError(TEXTS.changeFailed(detail(err, locale)))
        }
      }
    }
  ]
}
