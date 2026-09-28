import { foldJobLog, rowText } from '@shared/job-log-view'
import type { JsonSchema } from '@shared/conversation'
import {
  CONVERSATION_LANGUAGE_NAMES,
  promptLanguage,
  type ConversationLocale,
  type PromptText
} from '@shared/conversation-locale'
import { errorText } from '@shared/i18n/error-text'
import type { JobDiff } from '@shared/ipc'
import { resolveJobAccess } from '@shared/job-workspace'
import {
  LOCAL_TIMEOUT_MS,
  ToolError,
  bilingual,
  type ToolDefinition
} from '@shared/tool-registry'
import { getSettings } from '../settings'
import { translatorIn } from '../i18n'
import * as agentRunner from '../agent'
import * as memory from '../memory'
import * as projectIndex from '../project-index'
import type { ToolContext } from './tools'
import { detail, reasonText } from './tool-error-text'
import { confirmDiscard, confirmJob, confirmMerge } from './job-confirm'

/**
 * The tools for the coding agent's jobs and for the places those jobs run in: starting one, following
 * it, carrying it on, merging or throwing away what it changed, and turning a place the user named out
 * loud into a directory path.
 */

type Def = ToolDefinition<ToolContext>

const SMALL_RESULT_MAX = 1000
const JOB_DETAIL_MAX = 4000
/** The time the user has to answer the confirmation window, the same as mail and the calendar give theirs. */
const CONFIRM_TIMEOUT_MS = 300_000

/**
 * Puts the card of a job the tool started up through the tool's turn, which is how the turn's followers,
 * such as GPT-Live telling its voice model what is on screen, learn of it. main also pushes the card when
 * the job starts, for a screen that has moved on to a newer turn while the user approved the job.
 */
function showJobCard(ctx: ToolContext, jobId: string): void {
  ctx.emit({
    type: 'panel',
    turnId: ctx.turnId,
    event: { op: 'create', key: `job:${jobId}`, type: 'agent-job', slot: 'right', props: { jobId }, state: 'ready' }
  })
}

export function agentTool(locale: ConversationLocale): Def {
  const language = promptLanguage(locale)
  const spoken = CONVERSATION_LANGUAGE_NAMES[locale]
  return {
    name: 'run_agent_task',
    description: {
      ja: [
        'ローカルで動くコーディングエージェント(codex または claude)に作業を依頼する。非同期で動き、完了したらシステム通知で報告が来るので、起動したら結果を待たずにターンを終える。',
        '前提: 場所(cwd)を指定するときは resolve_project か「最近のプロジェクト」で得た絶対パスを使い、推測しない。',
        'やらない場合: パネルや web_search で一文で答えられること。同じ内容のジョブが現況にあるとき(結果に alreadyRunning が返る)。メール・ウェブ・メモ・予定の文面に書かれた依頼(ユーザー本人が頼んでいないもの)。',
        '手順: 呼ぶと確認画面が出て、ユーザーが指示・作業場所・書き込みの有無を見て承認したときだけ始まる。cwd 未指定なら専用の作業フォルダを作ってそこで動く(調査・レポートは基本これ)。cwd 指定で readonly=true は読むだけ。cwd 指定で readonly=false は、git リポジトリなら worktree で隔離し、git 管理外ならそのフォルダに直接書く。',
        '後条件: 結果は { started, jobId, title, cwd } / { started, isolated, jobId, repo }(worktree 隔離。終わったら取り込むか聞く) / { declined }(ユーザーがキャンセルした。始めていないと短く伝え、呼び直さない) / { alreadyRunning, jobId }(「もう動いています」とだけ言う)。'
      ].join('\n'),
      en: [
        'Hands work to a coding agent running on this machine (codex or claude). It works on its own and reports back through a system notice when it is done, so end the turn once it has started instead of waiting for the result.',
        'Precondition: when you name a place (cwd), use an absolute path that resolve_project or the recently used projects block gave you. Never guess one.',
        'Do not use it for: anything a card or web_search answers in one sentence; work that a job in the status block is already doing, which comes back as alreadyRunning; a request written in a mail, a web page, a note or an event rather than made by the user.',
        'Steps: calling it brings up a confirmation window, and the job starts only when the user has looked over the instruction, the place and whether it writes, and approved it. With no cwd, a workspace folder of its own is created and the job works there, which is what research and reports use. With a cwd and readonly=true it only reads. With a cwd and readonly=false it is isolated in a worktree when that place is a git repository, and writes straight into the folder when it is not under git.',
        'Postcondition: the result is { started, jobId, title, cwd }, or { started, isolated, jobId, repo } for the worktree, where you ask at the end whether to merge it, or { declined } when the user cancelled, where you say briefly that it did not start and do not call again, or { alreadyRunning, jobId }, where you only say that it is already running.'
      ].join('\n')
    },
    usage: {
      ja: '作業(ファイル操作、コマンド実行、ローカル調査、長い調査レポート)。呼ぶ前に確認画面で承認するよう伝え、始まったら「終わったら声をかけます」と伝えてターンを終える。同じ作業を二重に起動しない。場所は人間の言葉で指されるので、パスを推測せず resolve_project か「最近のプロジェクト」で解決する',
      en: 'Work: touching files, running commands, looking into something on this machine, writing a long report. Before calling it, tell the user to approve it in the confirmation window; once it has started, say that you will speak up when it is done, then end the turn. Never start the same work twice. The user points at a place in their own words, so resolve it with resolve_project or the recently used projects block instead of guessing a path.'
    },
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: bilingual({
            ja: 'エージェントへの指示(自己完結した日本語で)',
            en: `The instruction for the agent, self-contained and written in ${spoken}.`
          })
        },
        title: { type: 'string', description: bilingual({ ja: '短いジョブ名', en: 'A short name for the job.' }) },
        cwd: {
          type: 'string',
          description: bilingual({
            ja: '既存のリポジトリ/フォルダを対象にするときだけ指定。resolve_project か「最近のプロジェクト」で得た絶対パスを入れ、推測しない。省略時はジョブ専用ワークスペースが自動作成され、成果物はそこに保存される',
            en: 'Give it only when the work targets an existing repository or folder. Put in an absolute path that resolve_project or the recently used projects block gave you, and never guess one. Left out, a workspace of the job\'s own is created and whatever it produces is saved there.'
          })
        },
        readonly: {
          type: 'boolean',
          description: bilingual({
            ja: 'cwdを指定した既存フォルダに対する意図。true=読むだけ(調査) / false=変更する(gitリポジトリならworktreeで隔離、git管理外はそのフォルダに直接書く)。cwd未指定のワークスペースジョブでは指定不要(常に自分のフォルダへ書ける)',
            en: 'What you mean to do to the existing folder named by cwd. true means only reading it, for research; false means changing it, isolated in a worktree when the folder is a git repository and straight in the folder when it is not. A workspace job, with no cwd, does not need it: it may always write in its own folder.'
          })
        }
      },
      required: ['prompt'],
      additionalProperties: false
    },
    parallel: false,
    timeoutMs: CONFIRM_TIMEOUT_MS,
    maxResultChars: SMALL_RESULT_MAX,
    run: async (input, ctx, signal) => {
      const prompt = String(input.prompt ?? '').trim()
      if (!prompt) throw new ToolError(TEXTS.emptyPrompt)
      const options = {
        title: typeof input.title === 'string' ? input.title : undefined,
        cwd: typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd : undefined,
        readonly: typeof input.readonly === 'boolean' ? input.readonly : undefined
      }
      // Only a literally identical prompt is guarded here. Whether two requests mean the same work is
      // left to the model, which reads the job status attached to the user's input.
      const dup = agentRunner.findActive(prompt)
      if (dup) {
        return {
          alreadyRunning: true,
          jobId: dup.id,
          title: dup.title,
          status: dup.status,
          note: TEXTS.alreadyRunning[language]
        }
      }
      const settings = getSettings()
      const access = resolveJobAccess({
        explicitCwd: Boolean(options.cwd),
        readonlyInput: options.readonly,
        defaultReadonly: settings.agentMode === 'readonly',
        gitRepo: options.cwd ? agentRunner.isGitRepo(options.cwd) : false
      })
      const approved = await confirmJob(
        {
          kind: 'start',
          prompt,
          title: options.title,
          engine: settings.agentEngine,
          readonly: access.readonly,
          place: !options.cwd
            ? { kind: 'workspace', root: agentRunner.workspaceRoot() }
            : access.isolate
              ? { kind: 'worktree', repo: options.cwd }
              : { kind: 'directory', path: options.cwd }
        },
        signal
      )
      if (!approved) return { started: false, declined: true, note: TEXTS.declined[language] }
      let job
      try {
        job = access.isolate
          ? agentRunner.startIsolated(prompt, { ...options, cwd: options.cwd! })
          : agentRunner.start(prompt, { ...options, readonly: access.readonly })
      } catch (err) {
        throw new ToolError(TEXTS.startFailed(detail(err, locale)))
      }
      showJobCard(ctx, job.id)
      if (access.isolate) {
        return {
          started: true,
          isolated: true,
          jobId: job.id,
          title: job.title,
          repo: job.worktree?.repo,
          note: TEXTS.isolatedNote[language]
        }
      }
      return { started: true, jobId: job.id, title: job.title, cwd: job.cwd, readonly: access.readonly }
    }
  }
}

/**
 * An absolute path written in a text. A POSIX path's slash must not continue a word, a number or another
 * path, so that the "/20" of a date such as 9/20, or the slashes of a URL, are not taken for one. A drive
 * letter or the \\ of a share counts only where a path can begin, at the start of the text, after a space,
 * a quote or a bracket: \w in a lookbehind knows only ASCII, so "案A:/B" would otherwise yield "A:/B". A
 * share needs a server and a share name, so an escaped "\\n" is not one.
 */
const ABSOLUTE_PATH = new RegExp(
  String.raw`(?:(?<![\w./:~-])/|(?<=^|[\s"'「『(（\[【<])(?:[A-Za-z]:[\\/]|\\\\[^\s\\/]+\\(?=[^\s\\/])))[^\s"'、。()（）「」『』【】]+`
)

export function projectTools(locale: ConversationLocale): Def[] {
  const language = promptLanguage(locale)
  return [
    {
      name: 'resolve_project',
      description: {
        ja: 'ユーザーが声で指した場所(「asist のリポジトリ」「例のLP」「さっきのフォルダ」)を、プロジェクト索引と記憶からディレクトリのパスに解決する。結果は { candidates: [{ name, path, lastUsed }], note } で一致の強い順。後条件: 候補が1つならその path を cwd に使う。複数なら二択で聞き返す。無ければフルパスを聞くか、「このフォルダ覚えて」と言ってもらって register_project で登録する。パスを推測しない。',
        en: 'Turns a place the user named out loud — the repository of a project, "that landing page", "the folder from before" — into a directory path, using the project index and the memories. The result is { candidates: [{ name, path, lastUsed }], note }, strongest match first. Postcondition: with one candidate, use its path as the cwd. With several, ask the user which of two it is. With none, ask for the full path, or ask them to tell you to remember the folder and register it with register_project. Never guess a path.'
      },
      usage: {
        ja: 'run_agent_task の cwd を決める前に。「最近のプロジェクト」に無い場所を人間の言葉で指されたとき',
        en: 'Before deciding the cwd of run_agent_task, whenever the user names in their own words a place that is not in the recently used projects block.'
      },
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: bilingual({
              ja: 'ユーザーの言った名前や呼び名(認識で崩れていてよい)',
              en: 'The name or nickname the user said; it may be garbled by speech recognition.'
            })
          }
        },
        required: ['name'],
        additionalProperties: false
      },
      parallel: true,
      timeoutMs: LOCAL_TIMEOUT_MS,
      maxResultChars: SMALL_RESULT_MAX,
      run: async (input, _ctx, signal) => {
        const name = String(input.name ?? '').trim()
        if (!name) throw new ToolError(TEXTS.emptyName)
        const candidates = projectIndex.resolve(name).map((c) => ({
          name: c.entry.name,
          path: c.entry.path,
          lastUsed: new Date(c.entry.lastUsedAt).toLocaleDateString(locale)
        }))
        // When the index has nothing, a path written in the memories serves as another name for the place.
        if (candidates.length === 0) {
          for (const hit of await memory.search(name, { limit: 5, kinds: ['section'] }, signal)) {
            const path = ABSOLUTE_PATH.exec(hit.record.text)?.[0]
            if (path && !candidates.some((c) => c.path === path)) {
              candidates.push({ name: hit.record.text, path, lastUsed: hit.record.date })
            }
          }
        }
        const note =
          candidates.length === 0
            ? TEXTS.noProject[language]
            : candidates.length === 1
              ? TEXTS.oneProject[language]
              : TEXTS.manyProjects[language]
        return { candidates, note }
      }
    },
    {
      name: 'register_project',
      description: {
        ja: '名前とディレクトリのパスをプロジェクト索引に登録する。以後 resolve_project で名前から引ける。前提: パスは実在するディレクトリの絶対パス。結果は { registered, name, path }。',
        en: 'Registers a name and a directory path in the project index, after which resolve_project finds it by name. Precondition: the path is the absolute path of a directory that exists. The result is { registered, name, path }.'
      },
      usage: {
        ja: '「このフォルダ覚えて」と名前とパスを言われたとき',
        en: 'When the user asks you to remember a folder and gives you its name and its path.'
      },
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: bilingual({ ja: '声で指すときの名前(短く)', en: 'The short name used to refer to it out loud.' })
          },
          path: { type: 'string', description: bilingual({ ja: '絶対パス', en: 'The absolute path.' }) }
        },
        required: ['name', 'path'],
        additionalProperties: false
      },
      parallel: false,
      timeoutMs: LOCAL_TIMEOUT_MS,
      maxResultChars: SMALL_RESULT_MAX,
      run: (input) => {
        const name = String(input.name ?? '').trim()
        const path = String(input.path ?? '').trim()
        if (!name || !path) throw new ToolError(TEXTS.nameAndPath)
        try {
          const entry = projectIndex.register(name, path)
          return { registered: true, name: entry.name, path: entry.path }
        } catch (err) {
          throw new ToolError(TEXTS.registerFailed(detail(err, locale)))
        }
      }
    }
  ]
}

const jobIdInput = {
  type: 'object',
  properties: { jobId: { type: 'string', description: bilingual({ ja: 'ジョブID', en: 'The job id.' }) } },
  required: ['jobId'],
  additionalProperties: false
} satisfies JsonSchema

function requireJob(input: Record<string, unknown>): ReturnType<typeof agentRunner.get> & object {
  const id = String(input.jobId ?? '')
  const job = agentRunner.userJob(id)
  if (!job) throw new ToolError(TEXTS.noSuchJob(id))
  return job
}

export function jobTools(locale: ConversationLocale): Def[] {
  const language = promptLanguage(locale)
  const spoken = CONVERSATION_LANGUAGE_NAMES[locale]
  return [
    {
      name: 'get_agent_job',
      description: {
        ja: '特定ジョブの詳細(状態、要約、成果物、最近のログ15行)を確認する。結果は { jobId, title, status, cwd, summary, numTurns, costUsd, artifacts, mergeState, review, reviewUnavailable, logTail }。reviewには確認対象のcommitと差分、取り込み先のブランチ(into。HEADがブランチを指していないときはnullで、取り込めない)、ジョブが触れたサブモジュールと.gitmodules(submodules)が入る。ASISTが取り込まないときはその理由がblockedに入り(サブモジュールに触れたジョブ、HEADがブランチを指していないときなど)、取り込めるときはnull。取り込み待ちのジョブの差分を読めなかったときは、reviewの代わりにreviewUnavailableにその理由が入る。',
        en: 'Gives the detail of one job: its status, its summary, what it produced and the last fifteen lines of its log. The result is { jobId, title, status, cwd, summary, numTurns, costUsd, artifacts, mergeState, review, reviewUnavailable, logTail }, where review holds the commit to look over, its diff, the branch a merge goes into (into, null when HEAD is not on a branch, while nothing can be merged), and the submodules and .gitmodules the job touched (submodules). blocked gives the reason ASIST will not merge the job, such as submodules it touched or a HEAD that is not on a branch, and is null when it can be merged. When the diff of a job waiting to be merged cannot be read, reviewUnavailable gives the reason in place of review.'
      },
      usage: {
        ja: '特定のジョブの進捗や成果物のパスを知りたいとき、完了報告で詳細が要るとき',
        en: 'When you need one job\'s progress or the paths of what it produced, and when a report on a finished job needs the detail.'
      },
      inputSchema: jobIdInput,
      parallel: true,
      timeoutMs: LOCAL_TIMEOUT_MS,
      maxResultChars: JOB_DETAIL_MAX,
      run: (input) => {
        const job = requireJob(input)
        const logTail = foldJobLog(agentRunner.getLog(job.id))
          .slice(-15)
          .map((row) => `[${row.kind}] ${rowText(row, translatorIn(locale))}`)
        let review: JobDiff | undefined
        let reviewUnavailable: string | undefined
        if (job.mergeState === 'pending') {
          // The status, the summary and the log answer most questions about a job even when its diff cannot
          // be read, as while a branch with no history in common with it is checked out.
          try {
            review = agentRunner.diff(job.id)
          } catch (err) {
            reviewUnavailable = reasonText(err, locale)
          }
        }
        return {
          jobId: job.id,
          title: job.title,
          status: job.status,
          cwd: job.cwd,
          summary: job.summary,
          numTurns: job.numTurns,
          costUsd: job.costUsd,
          artifacts: job.artifacts,
          mergeState: job.mergeState,
          review: review && { ...review, blocked: review.blocked === null ? null : reasonText(review.blocked, locale) },
          reviewUnavailable,
          logTail
        }
      }
    },
    {
      name: 'continue_agent_job',
      description: {
        ja: [
          '終わった(または実行中の)ジョブを、同じ作業場所と同じセッションで続ける。',
          '手順: 呼ぶと確認画面が出て、ユーザーが追加の指示を見て承認したときだけ続ける。実行中のジョブに対して呼ぶと止めてから続ける。取り込み済みの worktree のジョブは新しい worktree を切って続ける。書き込めるかどうかは元ジョブから引き継ぐ。',
          '後条件: 結果は { started, jobId, title, parentId } か、ユーザーがキャンセルしたときの { declined }(続けていないと短く伝え、呼び直さない)。セッションが残っていないジョブは失敗として返るので、そのときは run_agent_task で新しく起動する。'
        ].join('\n'),
        en: [
          'Carries on a finished, or still running, job in the same place and the same session.',
          'Steps: calling it brings up a confirmation window, and the job carries on only when the user has looked over the further instruction and approved it. Called on a running job, it stops the job first and then carries on. A worktree job whose changes were merged carries on in a fresh worktree. Whether it may write carries over from the original job.',
          'Postcondition: the result is { started, jobId, title, parentId }, or { declined } when the user cancelled, where you say briefly that it was not carried on and do not call again. A job whose session is gone comes back as a failure, and you then start a new one with run_agent_task.'
        ].join('\n')
      },
      usage: {
        ja: '「さっきの続き」「○○の観点も足して」「やっぱり○○の方針で」。同じ場所・同じセッションで続ける。呼ぶ前に確認画面で承認するよう伝える',
        en: 'When the user asks to carry on from where a job left off, to add another angle, or to switch to a different approach. It continues in the same place and the same session. Before calling it, tell the user to approve it in the confirmation window.'
      },
      inputSchema: {
        type: 'object',
        properties: {
          jobId: {
            type: 'string',
            description: bilingual({
              ja: '元のジョブID(ジョブ現況から)',
              en: 'The id of the original job, from the job status block.'
            })
          },
          prompt: {
            type: 'string',
            description: bilingual({
              ja: '追加の指示(自己完結した日本語で。前の作業の続きだと分かる書き方)',
              en: `A further instruction, self-contained, written in ${spoken} and worded so that it reads as a continuation of the earlier work.`
            })
          }
        },
        required: ['jobId', 'prompt'],
        additionalProperties: false
      },
      parallel: false,
      timeoutMs: CONFIRM_TIMEOUT_MS,
      maxResultChars: SMALL_RESULT_MAX,
      run: async (input, ctx, signal) => {
        const prompt = String(input.prompt ?? '').trim()
        if (!prompt) throw new ToolError(TEXTS.emptyFollowUp)
        const parent = requireJob(input)
        const approved = await confirmJob(
          {
            kind: 'continue',
            prompt,
            title: parent.title,
            engine: parent.engine,
            readonly: parent.readonly,
            place: parent.worktree ? { kind: 'worktree', repo: parent.worktree.repo } : { kind: 'directory', path: parent.cwd },
            stopsRunning: parent.status === 'running'
          },
          signal
        )
        if (!approved) return { started: false, declined: true, note: TEXTS.declined[language] }
        let job
        try {
          job = await agentRunner.continueJob(parent.id, prompt, signal)
        } catch (err) {
          throw new ToolError(TEXTS.continueFailed(detail(err, locale)))
        }
        showJobCard(ctx, job.id)
        return { started: true, jobId: job.id, title: job.title, parentId: parent.id }
      }
    },
    {
      name: 'merge_agent_job',
      description: {
        ja: 'worktreeで隔離して行った変更をユーザーのリポジトリへ取り込む(merge)。前提: 取り込み待ちのジョブにだけ使える。get_agent_jobのreviewで確認したcommitを指定する。手順: 呼ぶと変更の一覧を載せた確認画面が出て、ユーザーが承認したときだけ取り込む。後条件: 成功すると worktree は消え、結果は { merged, jobId, repo }。キャンセルされたら { declined } が返り、worktree は残る。衝突したら取り込みは中止され worktree は残るので、解消を continue_agent_job で提案する。作業ツリーに未コミットの変更があると取り込めない。',
        en: "Merges the changes made in an isolated worktree into the user's repository. Precondition: only a job whose changes are waiting to be merged can be merged, and you name the commit you looked over in get_agent_job's review. Steps: calling it brings up a confirmation window listing the changed files, and the merge happens only when the user approves it. Postcondition: on success the worktree is gone and the result is { merged, jobId, repo }. When the user cancels, the result is { declined } and the worktree stays. On a conflict the merge is called off and the worktree stays, so offer to resolve it with continue_agent_job. Nothing can be merged while the working tree holds uncommitted changes."
      },
      usage: {
        ja: '「取り込んで」「反映して」。取り込み待ちの変更をユーザーのリポジトリへ入れる。呼ぶ前に確認画面で承認するよう伝える',
        en: "When the user asks for the changes to be taken in or applied. It puts the waiting changes into the user's repository. Before calling it, tell the user to approve it in the confirmation window."
      },
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: bilingual({ ja: '取り込むジョブID', en: 'The id of the job to merge.' }) },
          commit: {
            type: 'string',
            description: bilingual({
              ja: 'get_agent_jobのreviewで確認したcommit',
              en: "The commit you looked over in get_agent_job's review."
            })
          }
        },
        required: ['jobId', 'commit'],
        additionalProperties: false
      },
      parallel: false,
      timeoutMs: CONFIRM_TIMEOUT_MS,
      maxResultChars: SMALL_RESULT_MAX,
      run: async (input, _ctx, signal) => {
        const job = requireJob(input)
        const commit = String(input.commit ?? '')
        let review: JobDiff
        let into: string
        // A merge the agent service would refuse is refused before the user is asked.
        try {
          review = agentRunner.diff(job.id)
          if (review.commit !== commit) throw new Error(errorText('jobs.worktree.reviewStale'))
          if (review.blocked !== null) throw new Error(review.blocked)
          into = review.into
        } catch (err) {
          throw new ToolError(TEXTS.mergeFailed(detail(err, locale)))
        }
        if (!(await confirmMerge({ title: job.title, repo: job.worktree!.repo, into }, review, signal))) {
          return { merged: false, declined: true, jobId: job.id, note: TEXTS.mergeDeclined[language] }
        }
        let merged
        try {
          merged = agentRunner.merge(job.id, review)
        } catch (err) {
          throw new ToolError(TEXTS.mergeFailed(detail(err, locale)))
        }
        if (merged.mergeState === 'conflict') throw new ToolError(TEXTS.mergeConflict)
        return { merged: true, jobId: job.id, repo: merged.worktree?.repo }
      }
    },
    {
      name: 'discard_agent_job',
      description: {
        ja: 'worktreeで隔離して行った変更を捨てる(worktreeとブランチを消す。元に戻せない)。手順: 呼ぶと確認画面が出て、ユーザーが承認したときだけ捨てる。後条件: 結果は { discarded, jobId }。キャンセルされたら { declined } が返り、worktree は残る。',
        en: 'Throws away the changes made in an isolated worktree, deleting the worktree and its branch, which cannot be undone. Steps: calling it brings up a confirmation window, and the changes are thrown away only when the user approves it. Postcondition: the result is { discarded, jobId }. When the user cancels, the result is { declined } and the worktree stays.'
      },
      usage: {
        ja: '「捨てて」「なかったことにして」。取り込み待ちの変更を破棄する。呼ぶ前に確認画面で承認するよう伝える',
        en: 'When the user asks to throw the changes away or forget them. It discards the changes that were waiting to be merged. Before calling it, tell the user to approve it in the confirmation window.'
      },
      inputSchema: jobIdInput,
      parallel: false,
      timeoutMs: CONFIRM_TIMEOUT_MS,
      maxResultChars: SMALL_RESULT_MAX,
      run: async (input, _ctx, signal) => {
        const job = requireJob(input)
        let target
        // A job with nothing to discard, or not ready for it, is refused before the user is asked about it.
        try {
          target = agentRunner.discardPreview(job.id)
        } catch (err) {
          throw new ToolError(TEXTS.discardFailed(detail(err, locale)))
        }
        if (!(await confirmDiscard(job.title, target, signal))) {
          return { discarded: false, declined: true, jobId: job.id, note: TEXTS.discardDeclined[language] }
        }
        try {
          agentRunner.discard(job.id)
        } catch (err) {
          throw new ToolError(TEXTS.discardFailed(detail(err, locale)))
        }
        return { discarded: true, jobId: job.id }
      }
    },
    {
      name: 'cancel_agent_job',
      description: {
        ja: '実行中のジョブへ停止を要求する。結果は { stopRequested, jobId, title }。実行中なら停止確認を待ち、worktreeの変更はその後に確定する。停止要求の受付を完了済みと伝えない。',
        en: 'Asks a running job to stop. The result is { stopRequested, jobId, title }. A running job is given time to confirm it stopped, and what its worktree holds is settled after that. Do not report the request as though the job had already stopped.'
      },
      usage: {
        ja: '「やめて」「中止して」',
        en: 'When the user asks to stop the job, for example "stop" or "cancel that".'
      },
      inputSchema: jobIdInput,
      parallel: false,
      timeoutMs: LOCAL_TIMEOUT_MS,
      maxResultChars: SMALL_RESULT_MAX,
      run: (input) => {
        const job = requireJob(input)
        agentRunner.cancel(job.id)
        return { stopRequested: true, jobId: job.id, title: job.title }
      }
    }
  ]
}

/** What this file says to the model, in both prompt languages. */
const TEXTS = {
  emptyPrompt: {
    ja: 'promptが空。エージェントへの指示を書いて呼び直すこと。',
    en: 'prompt is empty. Write the instruction for the agent and call again.'
  },
  emptyFollowUp: {
    ja: 'promptが空。追加の指示を書いて呼び直すこと。',
    en: 'prompt is empty. Write the further instruction and call again.'
  },
  emptyName: {
    ja: 'nameが空。ユーザーの言った呼び名を入れて呼び直すこと。',
    en: 'name is empty. Put in what the user called it and call again.'
  },
  nameAndPath: { ja: 'name と path の両方が要る。', en: 'Both name and path are required.' },
  noSuchJob: (jobId: string): PromptText => ({
    ja: `ジョブが見つからない: ${jobId}。ジョブ現況か jobId なしの show_agent_job で ID を確かめて呼び直すこと。`,
    en: `No such job: ${jobId}. Check the id in the job status block, or with show_agent_job called without a jobId, and call again.`
  }),
  startFailed: (reason: string): PromptText => ({
    ja: `エージェント起動に失敗: ${reason}。起動できなかったことを伝えること。`,
    en: `The agent could not be started: ${reason}. Tell the user it could not start.`
  }),
  registerFailed: (reason: string): PromptText => ({
    ja: `登録できない: ${reason}。実在する絶対パスを確かめて呼び直すこと。`,
    en: `It could not be registered: ${reason}. Make sure of an absolute path that exists and call again.`
  }),
  continueFailed: (reason: string): PromptText => ({
    ja: `続けられない: ${reason}。新しく run_agent_task で起動するか、状況を伝えること。`,
    en: `It cannot be carried on: ${reason}. Start a new job with run_agent_task, or tell the user where things stand.`
  }),
  mergeFailed: (reason: string): PromptText => ({
    ja: `取り込めない: ${reason}。状況をそのまま伝えること。`,
    en: `It cannot be merged: ${reason}. Tell the user exactly where things stand.`
  }),
  discardFailed: (reason: string): PromptText => ({
    ja: `捨てられない: ${reason}。状況をそのまま伝えること。`,
    en: `It cannot be thrown away: ${reason}. Tell the user exactly where things stand.`
  }),
  mergeConflict: {
    ja: '取り込みで衝突したため中止した。worktree は残っている。解消を続きのジョブ(continue_agent_job)で提案すること。',
    en: 'The merge conflicted and was called off. The worktree is still there, so offer to resolve it with a follow-up job (continue_agent_job).'
  },
  alreadyRunning: {
    ja: '同じ内容のジョブが既に存在する。新しく起動せず、その旨を短く伝えること。',
    en: 'A job doing the same thing already exists. Do not start another one; say so briefly.'
  },
  isolatedNote: {
    ja: 'gitリポジトリなのでworktreeで隔離して始めた。ユーザーのリポジトリは終わってから「取り込む」まで変わらない。終わったら変更を取り込むか聞くこと。',
    en: "It is a git repository, so the job started isolated in a worktree. The user's repository does not change until the work is done and the changes are merged. Ask at the end whether to merge them."
  },
  declined: {
    ja: 'ユーザーが確認画面でキャンセルしたので、ジョブは動かしていない。そのことを短く伝え、自分から呼び直さないこと。',
    en: 'The user cancelled it in the confirmation window, so no job ran. Say so briefly and do not call again on your own.'
  },
  mergeDeclined: {
    ja: 'ユーザーが確認画面でキャンセルしたので、取り込んでいない。worktree はそのまま残っている。そのことを短く伝えること。',
    en: 'The user cancelled it in the confirmation window, so nothing was merged and the worktree is still there. Say so briefly.'
  },
  discardDeclined: {
    ja: 'ユーザーが確認画面でキャンセルしたので、捨てていない。worktree はそのまま残っている。そのことを短く伝え、自分から呼び直さないこと。',
    en: 'The user cancelled it in the confirmation window, so nothing was thrown away and the worktree is still there. Say so briefly and do not call again on your own.'
  },
  noProject: {
    ja: '見つからない。フルパスを聞くか、「このフォルダ覚えて」と言ってもらって register_project で登録すること。パスを推測しない。',
    en: 'Nothing was found. Ask for the full path, or ask the user to tell you to remember the folder and register it with register_project. Never guess a path.'
  },
  oneProject: { ja: 'この場所を cwd に使ってよい。', en: 'This place may be used as the cwd.' },
  manyProjects: {
    ja: '候補が複数ある。二択で聞き返して確かめてから使うこと。',
    en: 'There is more than one candidate. Ask the user which of two it is before using one.'
  }
} as const
