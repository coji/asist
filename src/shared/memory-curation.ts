import {
  CONVERSATION_LANGUAGE_NAMES,
  promptLanguage,
  promptText,
  type ConversationLocale,
  type PromptText
} from './conversation-locale'
import { errorText } from './i18n/error-text'
import { FIXED } from './memory-page'

/**
 * The material for the curation job, which is an Agent: it turns the conversation log into a
 * transcript the Agent can read and builds the prompt from it together with a short instruction. The
 * rules for how to write memories are not pasted into the prompt; they go into the worktree as an
 * Agent Skill, resources/skills/memory-curation for a Japanese conversation and
 * resources/skills/memory-curation-en for every other language, each holding SKILL.md, the format
 * specification, the templates and the validation script. Running the job, meaning the worktree, the
 * CLI and taking the result back in, is main's memory-curation.ts.
 */

export interface TranscriptRecord {
  t: number
  kind: string
  turnId?: number
  text?: string
  name?: string
  input?: string
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** What the transcript calls each kind of line. The Agent reads them in the language of the prompt. */
const SPEAKER: Record<'user' | 'assistant' | 'notice' | 'tool', PromptText> = {
  user: { ja: 'ユーザー', en: 'User' },
  assistant: { ja: 'アシスタント', en: 'Assistant' },
  notice: { ja: 'アプリの通知', en: 'app notice' },
  tool: { ja: 'ツール', en: 'tool' }
}

/**
 * Renders one day of the conversation log as lines of the form `[HH:MM #turnId] speaker: text`. A tool
 * contributes only its name, and an app notice is marked so that it is not read as the user speaking.
 * The notes sent to the model with an utterance, on the user record or as a note record, are left
 * out: the memories they show come from the memory this transcript is curated into.
 */
export function renderTranscript(records: readonly TranscriptRecord[], locale: ConversationLocale): string {
  const label = (of: keyof typeof SPEAKER): string => promptText(locale, SPEAKER[of])
  const lines: string[] = []
  for (const record of records) {
    const d = new Date(record.t)
    const stamp = `[${pad(d.getHours())}:${pad(d.getMinutes())}${record.turnId !== undefined ? ` #${record.turnId}` : ''}]`
    if (record.kind === 'user') lines.push(`${stamp} ${label('user')}: ${record.text ?? ''}`)
    else if (record.kind === 'assistant') lines.push(`${stamp} ${label('assistant')}: ${record.text ?? ''}`)
    else if (record.kind === 'notice') lines.push(`${stamp} (${label('notice')}) ${record.text ?? ''}`)
    else if (record.kind === 'tool') lines.push(`${stamp} (${label('tool')} ${record.name ?? ''} ${record.input ?? ''})`)
  }
  return lines.join('\n')
}

/**
 * Whether the user spoke at all on a day, which is what decides that the day is worth curating. It is
 * read from the records rather than from the rendered transcript, whose speaker labels follow the
 * language of the prompt.
 */
export const hasUserSpeech = (records: readonly TranscriptRecord[]): boolean =>
  records.some((record) => record.kind === 'user')

/**
 * The days from the stored start date, or from the day after the last curated day, up to yesterday, at
 * most maxDays of them.
 */
export function pendingDays(
  state: { curatedThrough: string | null; pendingFrom: string | null },
  now: number,
  maxDays = 7
): Date[] {
  const start = new Date(now)
  const yesterday = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1)
  const from = state.curatedThrough ?? state.pendingFrom
  if (!from) throw new Error(errorText('memory.errors.startDayMissing'))
  const [y, m, d] = from.split('-').map(Number)
  let cursor = new Date(y, m - 1, d + (state.curatedThrough ? 1 : 0))
  const days: Date[] = []
  while (cursor.getTime() <= yesterday.getTime() && days.length < maxDays) {
    days.push(cursor)
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)
  }
  return days
}

/**
 * Whether the daily curation is due: a day before today is not curated yet, and no curation has failed
 * since the last midnight. The day starts at local midnight, so the curation runs right after 0:00, or at
 * the first check after the app starts or the Mac wakes when it was not running then. A failure is not
 * retried on its own until the next day, so that a curation that keeps failing does not start an Agent
 * every minute; the button on the settings screen still starts one.
 */
export function curationDue(state: { curatedThrough: string | null; lastFailureAt: number | null }, now: number): boolean {
  const today = new Date(now)
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (state.lastFailureAt !== null && state.lastFailureAt >= midnight) return false
  if (state.curatedThrough === null) return true
  const [y, m, d] = state.curatedThrough.split('-').map(Number)
  const dayAfter = new Date(y, m - 1, d + 1).getTime()
  return dayAfter < midnight
}

/** The skill's name, used both as its directory name in the worktree and as the `name` in its SKILL.md. */
export const CURATION_SKILL = 'memory-curation'

/**
 * Which of the two skills under resources/skills is copied into the worktree. They hold the same
 * workflow written in the two prompt languages, and both land in the worktree under CURATION_SKILL, so
 * the Agent is told about one skill by one name whatever language it writes in.
 */
export const curationSkillSource = (locale: ConversationLocale): string =>
  promptLanguage(locale) === 'ja' ? CURATION_SKILL : `${CURATION_SKILL}-en`

/** Where the skill goes inside the worktree: claude reads .claude/skills and codex reads .agents/skills. */
export const SKILL_DIRS = ['.claude/skills', '.agents/skills'] as const
/**
 * The scripts under the skill's scripts/ that the Agent runs to check its own work: what each document of
 * the prompt costs against its limit, and the rules of the markdown. They are the only commands a claude
 * curation may run.
 */
export const CURATION_SCRIPTS = ['count.py', 'validate.py'] as const
/**
 * The command the Agent runs a script of the skill with, `skill` being the skill's folder as the Agent names
 * it. The uv is the copy of the bundled one that ASIST puts in that folder, run on the Python ASIST installed
 * for it, so a curation needs neither Node nor a Python of the user's. It is named by its path rather than
 * found on PATH, because the shell a command runs in sets PATH again: codex runs it in a login shell and
 * claude in a snapshot of the user's, where path_helper on macOS and the user's startup files can put a uv of
 * the user's ahead of any folder ASIST added. On Windows the copy is uv.exe, which this name finds as well.
 * --no-project keeps uv from looking for a project in the folders above the worktree.
 */
export const curationScriptCommand = (skill: string, script: (typeof CURATION_SCRIPTS)[number]): string =>
  `${skill}/uv run --no-project ${skill}/scripts/${script}`
/**
 * The rules of the memory's markdown and the values they read, which both skills' scripts import from two
 * folders above their scripts/: resources/skills in the app, and each of SKILL_DIRS in the worktree.
 */
export const FORMAT_FILES = ['memory_format.py', 'memory-format.json'] as const
/**
 * The .gitignore of the memory repository. The app copies the skill and AGENTS.md in on every run, so
 * they stay out of the memory commits. A save from the memory screen that a power loss cuts off before its
 * rename leaves its temporary file beside the document, which ensureRepo would otherwise commit as memory.
 */
export const MEMORY_GITIGNORE = ['.claude/', '.agents/', 'AGENTS.md', '*.tmp', ''].join('\n')

const AGENTS_MD: PromptText = {
  ja: `# ASIST の記憶

このディレクトリは音声アシスタント ASIST の記憶の本体で、markdown で書かれている。整理を頼まれたら必ず \`${CURATION_SKILL}\`
スキル(\`.claude/skills/${CURATION_SKILL}\` と \`.agents/skills/${CURATION_SKILL}\` にある同じもの)の SKILL.md を読み、
その手順に従うこと。git は操作しない(コミットは ASIST が行う)。このディレクトリの外は読み書きしない。

## Mandatory skill usage

- Use \`$${CURATION_SKILL}\` for any request to curate, organize, or update this memory directory.
`,
  en: `# The memory of ASIST

This directory is the memory of the voice assistant ASIST, written in markdown. When you are asked to
curate it, always read the SKILL.md of the \`${CURATION_SKILL}\` skill (the same one lies in
\`.claude/skills/${CURATION_SKILL}\` and \`.agents/skills/${CURATION_SKILL}\`) and follow it. Do not run git:
ASIST makes the commits. Do not read or write anything outside this directory.

## Mandatory skill usage

- Use \`$${CURATION_SKILL}\` for any request to curate, organize, or update this memory directory.
`
}

/** The AGENTS.md placed at the root of the worktree, which both codex and claude read. */
export const worktreeAgentsMd = (locale: ConversationLocale): string => promptText(locale, AGENTS_MD)

export interface CurationPromptInput {
  /** The days not curated yet with their transcripts, oldest first. */
  days: ReadonlyArray<{ date: string; transcript: string }>
  today: string
  /** The language the conversation was held in, which is the language the memory is written in. */
  locale: ConversationLocale
  /** The persona from the settings screen, the starting point for me.md. Empty means none. */
  persona?: string
}

const PROMPT = {
  instruction: {
    ja: `今日は {today}。\`${CURATION_SKILL}\` スキル(.claude/skills と .agents/skills にある。まず SKILL.md を読む)に従い、次の会話をこのディレクトリの記憶に反映せよ。`,
    en: `Today is {today}. Follow the \`${CURATION_SKILL}\` skill (it lies in .claude/skills and .agents/skills; read its SKILL.md first) and fold the conversations below into the memory in this directory. The conversation is held in {language}: write the body of every file in {language}, and write the fixed headings the skill names, such as "${FIXED.summary.en}", in English.`
  },
  persona: { ja: '# キャラクター設定(me.md、アシスタント自身の出発点)', en: '# Character settings (me.md, where the assistant starts from)' },
  conversationOf: { ja: '# {date} の会話', en: '# The conversation of {date}' },
  noConversation: { ja: '(会話なし)', en: '(no conversation)' }
} as const satisfies Record<string, PromptText>

export function buildCurationPrompt(input: CurationPromptInput): string {
  const text = (of: keyof typeof PROMPT): string => promptText(input.locale, PROMPT[of])
  const parts = [
    text('instruction')
      .replace('{today}', input.today)
      .replaceAll('{language}', CONVERSATION_LANGUAGE_NAMES[input.locale])
  ]
  if (input.persona?.trim()) parts.push(`${text('persona')}\n${input.persona.trim()}`)
  for (const day of input.days) {
    parts.push(`${text('conversationOf').replace('{date}', day.date)}\n${day.transcript || text('noConversation')}`)
  }
  return parts.join('\n\n')
}
