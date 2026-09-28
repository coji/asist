import { promptLanguage, type ConversationLocale, type PromptLanguage, type PromptText } from '@shared/conversation-locale'
import { LOCAL_TIMEOUT_MS, ToolError, bilingual, inputJsonSchema, type ToolDefinition } from '@shared/tool-registry'
import {
  TASK_STATUSES,
  TASK_STATUS_LABEL,
  openTasks,
  taskInputSchema,
  taskSummary,
  titleIdentity,
  type TaskStatus
} from '@shared/tasks'
import { getTaskService } from '../user-tasks'
import type { ToolContext } from './tools'
import { detail } from './tool-error-text'
import { CARD_FIELD, putUpCard } from './cards'

/**
 * The task tools: listing, adding, changing and removing. list_tasks puts up the tasks card when asked.
 * The board, the list screen and the TODO card all end up with the same content, because they are
 * updated from what main broadcasts once a write has been committed.
 */

/** The words the tools return in `statusLabel`, so the description and the result agree. */
const statusHelp = (language: PromptLanguage): string =>
  TASK_STATUSES.map((status) => `${status}=${TASK_STATUS_LABEL[status][language]}`).join(' / ')

/** What this file says to the model, in both prompt languages. */
const TEXTS = {
  addFailed: (reason: string): PromptText => ({
    ja: `タスクを追加できません: ${reason}。入力を直して呼び直すこと。`,
    en: `The task could not be added: ${reason}. Correct the input and call again.`
  }),
  updateFailed: (reason: string): PromptText => ({
    ja: `タスクを変更できません: ${reason}。list_tasks で id を確かめて呼び直すこと。`,
    en: `The task could not be changed: ${reason}. Check the id with list_tasks and call again.`
  }),
  removeFailed: (reason: string): PromptText => ({
    ja: `タスクを消せません: ${reason}。list_tasks で id を確かめて呼び直すこと。`,
    en: `The task could not be removed: ${reason}. Check the id with list_tasks and call again.`
  })
} as const

export function taskTools(locale: ConversationLocale): ToolDefinition<ToolContext>[] {
  const language = promptLanguage(locale)
  return [
    {
      name: 'list_tasks',
      description: {
        ja: `タスクの一覧を返す。status で絞る(${statusHelp('ja')} / open=未完了)。省くと未完了。各タスクの id を update_task と remove_task に使う。期限 due は端末の日付の YYYY-MM-DD。結果は { count, today, tasks }。`,
        en: `Returns the list of tasks. status narrows it (${statusHelp('en')} / open=unfinished), and left out it gives the unfinished ones. Each task's id is what update_task and remove_task take. due is a local calendar day written YYYY-MM-DD. The result is { count, today, tasks }.`
      },
      usage: {
        ja: '「やることある?」「今日やることは?」「〜は終わった?」のように一覧や状態を聞かれたとき。画面に見せるなら card を付ける(カードは未完了のタスクを出す)。対象が曖昧なときは候補を挙げて聞く',
        en: 'When the user asks what is on their list, what they have to do today, or whether something is finished. Set card to show them on screen as well; the card shows the unfinished tasks. When it is unclear which task they mean, name the candidates and ask.'
      },
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string', enum: [...TASK_STATUSES, 'open'] }, card: CARD_FIELD },
        additionalProperties: false
      },
      parallel: true,
      timeoutMs: LOCAL_TIMEOUT_MS,
      maxResultChars: 16_000,
      run: async (input, ctx, signal) => {
        if (input.card === true) await putUpCard('todo', {}, ctx, signal, locale)
        const status = typeof input.status === 'string' ? input.status : 'open'
        const all = await getTaskService().list()
        const tasks = status === 'open' ? openTasks(all) : all.filter((task) => task.status === status)
        return { count: tasks.length, today: localDay(), tasks: tasks.map((task) => taskSummary(task, language)) }
      }
    },
    {
      name: 'add_task',
      description: {
        ja: `タスクを追加する。title は短い動詞の句、due は YYYY-MM-DD(「明日」「金曜」は発話の日時から計算する)。status(${statusHelp('ja')})を省くとやること。未完了に同じ題があれば追加せず、その既存を duplicate: true で返す。`,
        en: `Adds a task. title is a short verb phrase and due is YYYY-MM-DD; work a relative day such as tomorrow or Friday out from the date stamped on the utterance. Leaving status out (${statusHelp('en')}) makes it a to-do. When an unfinished task already has the same title, nothing is added and that existing task comes back with duplicate: true.`
      },
      usage: {
        ja: '「〜をやることに追加して」「〜を忘れないようにして」「〜しないと」。期限を言われたら due を付け、追加したことを一言で伝える',
        en: 'When the user asks to put something on the list, not to let them forget it, or says they have to do it. Set due when they name a deadline, and say in one sentence that you added it.'
      },
      inputSchema: inputJsonSchema(taskInputSchema),
      parallel: false,
      timeoutMs: LOCAL_TIMEOUT_MS,
      maxResultChars: 3_000,
      run: async (input, _ctx, signal) => {
        const title = typeof input.title === 'string' ? input.title : ''
        const identity = titleIdentity(title)
        const existing = openTasks(await getTaskService().list()).find((task) => titleIdentity(task.title) === identity)
        if (existing) return { duplicate: true, task: taskSummary(existing, language) }
        try {
          return { duplicate: false, task: taskSummary(await getTaskService().create(input, signal), language) }
        } catch (err) {
          throw new ToolError(TEXTS.addFailed(detail(err, locale)))
        }
      }
    },
    {
      name: 'update_task',
      description: {
        ja: `タスクの題・補足・期限・状態を変える。id は list_tasks か add_task の結果から。変える項目だけ渡す。status を done にすると完了、todo か doing に戻すと未完了に戻る(${statusHelp('ja')})。due に null を渡すと期限を消す。`,
        en: `Changes a task's title, notes, due date or status. Take id from the result of list_tasks or add_task, and pass only the fields that change. Setting status to done finishes it, and putting it back to todo or doing makes it unfinished again (${statusHelp('en')}). Passing null for due clears the due date.`
      },
      usage: {
        ja: '「〜を進行中にして」「〜終わった」「〜の期限を金曜にして」。対象が2つ以上に当てはまるなら list_tasks の候補を挙げて聞いてから呼ぶ',
        en: 'When the user says a task is under way, that it is done, or gives it a new deadline. When two or more tasks could be meant, name the candidates from list_tasks and ask before calling it.'
      },
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          notes: { type: 'string' },
          due: {
            type: ['string', 'null'],
            description: bilingual({ ja: 'YYYY-MM-DD。null で期限なし', en: 'YYYY-MM-DD; null means no due date.' })
          },
          status: { type: 'string', enum: [...TASK_STATUSES] }
        },
        required: ['id'],
        additionalProperties: false
      },
      parallel: false,
      timeoutMs: LOCAL_TIMEOUT_MS,
      maxResultChars: 3_000,
      run: async (input, _ctx, signal) => {
        const { id, ...patch } = input
        try {
          return { task: taskSummary(await getTaskService().update(String(id ?? ''), patch, signal), language) }
        } catch (err) {
          throw new ToolError(TEXTS.updateFailed(detail(err, locale)))
        }
      }
    },
    {
      name: 'remove_task',
      description: {
        ja: 'タスクを一覧から取り除く。完了にするのではなく消す。結果は消したタスク。',
        en: 'Takes a task off the list. It deletes the task rather than finishing it. The result is the task that was removed.'
      },
      usage: {
        ja: '「〜を消して」「〜はもういらない」と明示されたときだけ。終わったのなら update_task で done にする',
        en: 'Only when the user explicitly says to delete a task or that they no longer need it. When it is simply finished, set it to done with update_task instead.'
      },
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false
      },
      parallel: false,
      timeoutMs: LOCAL_TIMEOUT_MS,
      maxResultChars: 3_000,
      run: async (input, _ctx, signal) => {
        try {
          return { removed: taskSummary(await getTaskService().remove(String(input.id ?? ''), signal), language) }
        } catch (err) {
          throw new ToolError(TEXTS.removeFailed(detail(err, locale)))
        }
      }
    }
  ]
}

/** Today's date on this machine, returned with the result as the reference for relative due dates. */
function localDay(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export type { TaskStatus }
