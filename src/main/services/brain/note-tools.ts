import type { ConversationLocale, PromptText } from '@shared/conversation-locale'
import { MAX_NOTE_CHARS, type NoteSummary } from '@shared/notes'
import { LOCAL_TIMEOUT_MS, ToolError, bilingual, type ToolDefinition } from '@shared/tool-registry'
import { getNoteService } from '../user-notes'
import type { ToolContext } from './tools'
import { detail } from './tool-error-text'
import { CARD_FIELD, putUpCard } from './cards'

/**
 * The note tools: writing a new note, searching and reading. A note is the user's own document, so
 * the conversation never changes or deletes one that exists; that belongs to the notes screen. The
 * memory is a different thing, which the curation Agent writes and recall reads.
 */

type Def = ToolDefinition<ToolContext>

const SEARCH_LIMIT = 10
const READ_MAX_CHARS = 12_000

const brief = (note: NoteSummary, locale: ConversationLocale): Record<string, unknown> => ({
  id: note.id,
  title: note.title,
  excerpt: note.excerpt,
  updated: new Date(note.updatedAt).toLocaleString(locale)
})

export function noteTools(locale: ConversationLocale): Def[] {
  return [
    {
      name: 'add_note',
      description: {
        ja: `新しいメモを markdown で書いて保存し、メモのカードを出す。1行目は内容が分かる短い見出し(# 見出し)にし、本文は箇条書きや段落で整える。ユーザーが言った内容を省かず、足さない。既存のメモを書き換えることはできない。${MAX_NOTE_CHARS}文字まで。結果は保存したメモの { id, title }。`,
        en: `Writes a new note in markdown, saves it and puts up the notes card. Make the first line a short heading that says what it is about (# heading), and lay the body out as a list or paragraphs. Keep everything the user said and add nothing of your own. An existing note cannot be changed. Up to ${MAX_NOTE_CHARS} characters. The result is the saved note's { id, title }.`
      },
      usage: {
        ja: '「メモして」「メモに残して」「書き留めておいて」と言われたとき。保存したことを一言で伝える。やることなら add_task、覚えておいてほしい好みや事実は記憶に任せる',
        en: 'When the user asks you to take a note, to write something down or to keep it in a note. Say in one sentence that it is saved. Something to do goes to add_task instead, and a preference or a fact to remember is left to the memory.'
      },
      inputSchema: {
        type: 'object',
        properties: {
          markdown: {
            type: 'string',
            description: bilingual({ ja: 'メモの全文。1行目は # で始まる見出し', en: 'The whole note. The first line is a heading starting with #.' })
          }
        },
        required: ['markdown'],
        additionalProperties: false
      },
      parallel: false,
      timeoutMs: LOCAL_TIMEOUT_MS,
      maxResultChars: 1_000,
      run: async (input, ctx, signal) => {
        let note: NoteSummary
        try {
          note = await getNoteService().create(input.markdown, signal)
        } catch (err) {
          throw new ToolError(TEXTS.addFailed(detail(err, locale)))
        }
        ctx.emit({
          type: 'panel',
          turnId: ctx.turnId,
          event: { op: 'create', key: 'notes', type: 'notes', slot: 'right', props: { focusId: note.id }, state: 'ready' }
        })
        return { id: note.id, title: note.title }
      }
    },
    {
      name: 'search_notes',
      description: {
        ja: `メモを探す。query の語をすべて含むメモを、更新の新しい順に${SEARCH_LIMIT}件まで返す。query を省くと最近のメモ。結果は { count, notes: [{ id, title, excerpt, updated }] }。全文は read_note で読む。`,
        en: `Looks through the notes. It returns up to ${SEARCH_LIMIT} notes that contain every word of query, the most recently changed first; left out, it gives the latest notes. The result is { count, notes: [{ id, title, excerpt, updated }] }. Read a whole note with read_note.`
      },
      usage: {
        ja: '「メモ見て」「〜のメモあった?」「前にメモした〜」と言われたとき。画面に見せるなら card を付ける(カードは最近のメモを出す)。記憶を思い出すのは recall で、メモとは別',
        en: 'When the user asks you to look at their notes, whether there is a note about something, or about something they wrote down before. Set card to show them on screen as well; the card shows the latest notes. Recalling a memory is recall, which is separate from the notes.'
      },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: bilingual({ ja: 'メモに含まれる語。空白で区切ると全部を含むもの', en: 'Words in the note. Separated by spaces, all of them must appear.' }) },
          card: CARD_FIELD
        },
        additionalProperties: false
      },
      parallel: true,
      timeoutMs: LOCAL_TIMEOUT_MS,
      maxResultChars: 4_000,
      run: async (input, ctx, signal) => {
        if (input.card === true) await putUpCard('notes', {}, ctx, signal, locale)
        const query = typeof input.query === 'string' ? input.query.trim() : ''
        const notes = (await getNoteService().search(query)).slice(0, SEARCH_LIMIT)
        return { count: notes.length, notes: notes.map((note) => brief(note, locale)) }
      }
    },
    {
      name: 'read_note',
      description: {
        ja: 'メモ一件の全文を markdown で返す。id は search_notes か add_note の結果から。結果は { id, markdown }。',
        en: 'Returns the whole of one note in markdown. Take id from the result of search_notes or add_note. The result is { id, markdown }.'
      },
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false
      },
      parallel: true,
      timeoutMs: LOCAL_TIMEOUT_MS,
      maxResultChars: READ_MAX_CHARS,
      run: async (input) => {
        const id = String(input.id ?? '')
        try {
          return { id, markdown: await getNoteService().read(id) }
        } catch (err) {
          throw new ToolError(TEXTS.readFailed(detail(err, locale)))
        }
      }
    }
  ]
}

/** What this file says to the model, in both prompt languages. */
const TEXTS = {
  addFailed: (reason: string): PromptText => ({
    ja: `メモを保存できません: ${reason}。入力を直して呼び直すか、保存できなかったことを伝えること。`,
    en: `The note could not be saved: ${reason}. Correct the input and call again, or tell the user it could not be saved.`
  }),
  readFailed: (reason: string): PromptText => ({
    ja: `メモを読めません: ${reason}。search_notes で id を確かめて呼び直すこと。`,
    en: `The note could not be read: ${reason}. Check the id with search_notes and call again.`
  })
} as const
