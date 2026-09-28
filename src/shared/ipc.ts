import type { AizuchiClassification } from './aizuchi-classifier'
import type { AgentStreamEvent } from './agent-stream'
import type { UsageDay } from './api-usage'
import type { AppUpdateState } from './app-update'
import type { CalendarChange, CalendarChangeResult, CalendarEvent, CalendarListRange, CalendarStatus } from './calendar'
import type { ConfirmEvent, ConfirmRequest } from './confirm'
import type { MiniAppTarget, MiniAppView } from './mini-apps'
import type { NoteSummary } from './notes'
import type { PlatformCapabilities } from './platform'
import type {
  MailAccount,
  MailAccountInput,
  MailAccountPatch,
  MailChangeInput,
  MailChangeResult,
  MailDraft,
  MailDraftInput,
  MailDraftPatch,
  MailEvent,
  MailListQuery,
  MailListResult,
  MailMessage,
  MailMessageBody,
  MailProbeResult,
  MailReply,
  MailReplySend,
  MailStatus
} from './mail'
import type { Task, TaskInput, TaskMove, TaskPatch } from './tasks'
import type { AsrModel, ResolvedAsrModel } from './asr-models'
import type { CacheMissReason } from './cache-diagnosis'
import type { AppSettings, SettingsPatch } from './settings'
export type { AppSettings } from './settings'
import type { ConversationModel, LlmProvider } from './llm-catalog'
export type { ConversationModel, LlmProvider } from './llm-catalog'
import type { LiveEngine, VoiceEngine } from './voice-engine'
export type { VoiceEngine } from './voice-engine'

/**
 * The IPC contract shared by main, preload and renderer. Channel names and payload types are defined
 * here and nowhere else.
 */

/** A timeline of vowels in seconds, built from VOICEVOX's mora information. */
export interface PhonemeEvent {
  vowel: string
  start: number
  end: number
}

/**
 * The role of a one-off clip, the segments with index -1. `aizuchi` is the aizuchi at the head of the
 * turn, `bridge` fills the gap until the real answer, `listening` is a listening aizuchi and
 * `preview` is the trial playback on the settings screen.
 */
export type ClipRole = 'aizuchi' | 'bridge' | 'listening' | 'preview'

/** One sentence of a reply as speech. With neither `audio` nor `stream` the renderer falls back to Web Speech. */
export interface SpeechSegment {
  turnId: number
  /** The reply counts from 0, -1 is a one-off clip whose role is in `clip`, and 998 is the filler played while a tool runs. */
  index: number
  text: string
  /** WAV as base64, or null when no TTS engine is connected or the audio arrives through `stream`. */
  audio: string | null
  /**
   * Set when the engine returns the audio while it is still synthesizing. The samples then follow
   * as `segmentAudio` turn events, so playback starts after the first piece instead of the whole sentence.
   */
  stream?: { sampleRate: number }
  phonemes: PhonemeEvent[] | null
  /** Playback volume from 0 to 1, used to play a listening aizuchi quietly. It defaults to 1.0. */
  volume?: number
  /** The role when `index` is -1. It decides which playback start is measured and how self-echo is recorded. */
  clip?: ClipRole
}

/**
 * The speech engine: one that speaks the VOICEVOX-compatible API, Qwen3-TTS on the local MLX
 * runtime, the macOS speech synthesis, or none at all. With `none` the reply is neither synthesized nor played and arrives only as text in the
 * feed, for a user who wants text alone.
 */
export type TtsEngine = 'voicevox' | 'aivisspeech' | 'qwen3tts' | 'system' | 'none'

/** The result of starting the native microphone capture, which cancels the echo of what the machine plays. */
export interface NativeMicStartResult {
  ok: boolean
  /** The sample rate of the frames when `ok`. It is currently always 48000. */
  sampleRate: number
  reason?: string
}

/** The pushed state of the native microphone capture. A capture that died reports `running` false. */
export interface NativeMicStatus {
  running: boolean
  reason?: string
}

/**
 * The latest estimate from the turn-taking worker (MaAI), pushed once per VAP frame, which is every
 * 80 to 100 ms. `user` is ch0, the microphone, and `assistant` is ch1, the TTS. `eotUser` is
 * 1 - `pNowUser`.
 */
export interface VapState {
  /** The total seconds of audio the worker has processed. */
  t: number
  pNowUser: number
  pNowAssistant: number
  pFutureUser: number
  pFutureAssistant: number
  /** The probability that the user has finished speaking. The dynamic hangover reads it. */
  eotUser: number
  /**
   * From the backchannel detector bc_det: the probability that the user is saying an aizuchi such as
   * "うん" or "はい" right now. Deciding whether to interrupt playback reads it.
   */
  bcDetUser: number
  /** From the backchannel model bc_2type: the probability that a continuer such as "うん" belongs here. */
  bcReact: number
  /** From the backchannel model bc_2type: the probability that an assessment such as "なるほど" belongs here. */
  bcEmo: number
  /** From the nod model: the probability of a short nod and of a long one. */
  nodShort: number
  nodLong: number
  /** The inference time of one frame, in milliseconds. */
  inferMs: number
}

export interface VapStatus {
  runtimeInstalled: boolean
  /** Whether every model has been downloaded: turn-taking, backchannel and nod. */
  modelsInstalled: boolean
  running: boolean
}

/** The state of the memory embedding worker (multilingual-e5) and how many memories carry a vector. */
export interface EmbeddingStatus {
  runtimeInstalled: boolean
  modelInstalled: boolean
  running: boolean
  /** Whether the settings enable it. It can be switched off even when everything is ready. */
  enabled: boolean
  /** Whether the worker is starting or memories are being turned into vectors, so that `embedded` is still rising. */
  converting: boolean
  /** How many active memories carry a vector, and how many active memories there are. */
  embedded: number
  total: number
  /** The model in use, as `id@revision`. */
  model: string
}

export interface SpeakerOption {
  id: number
  label: string
}

/**
 * The categories of pre-synthesized aizuchi. They are the classes of the aizuchi classifier in
 * shared/aizuchi-classifier.ts that actually get played: `flow` is a plain reply or listening
 * aizuchi, `understand` marks understanding, `agree` agrees, `ack` acknowledges, `work` announces
 * that work is starting, `think` is thinking, `check` is a short answer to a confirmation, `empathy`
 * sympathizes, `cheer` reacts to good news, `surprise` is surprise and `correct` apologizes for a
 * correction. The weights of `flow` through `work` come from frequencies in a corpus of about 30
 * hours of real conversation; the rest were set by hand.
 */
export type AizuchiCategory =
  | 'flow'
  | 'understand'
  | 'agree'
  | 'ack'
  | 'think'
  | 'check'
  | 'work'
  | 'empathy'
  | 'cheer'
  | 'surprise'
  | 'correct'

export interface AizuchiClip {
  /** The spoken text. It is also injected into the brain as context. */
  text: string
  category: AizuchiCategory
  /** The selection weight, taken from the frequency in the corpus. */
  weight: number
  /** WAV as base64, or null when no TTS is connected, in which case Web Speech reads it. */
  audio: string | null
}

/**
 * The look-ahead made while the user is still speaking, by passing the partial transcript to a fast
 * model. `bridge` is the short phrase placed between the aizuchi and the real answer, such as
 * "会議の件ですね。", and it is an empty string when there is none. The kind of aizuchi is not decided
 * here but by the classifier in shared/aizuchi-classifier.ts.
 */
export interface BridgePlan {
  bridge: string
}

/** The state of the aizuchi classifier worker (ModernBERT-ja 70m). */
export interface AizuchiClassifierStatus {
  runtimeInstalled: boolean
  modelInstalled: boolean
  running: boolean
}

/** A synthesized bridge. `audio` is null when no TTS is connected, in which case Web Speech reads it. */
export interface BridgeClip {
  text: string
  audio: string | null
}

/**
 * The kind of listening aizuchi. A `continuer` invites the user to go on, as in "うん" or "はい", and
 * an `assessment` shows interest or agreement, as in "なるほど" or "確かに". They are the two types of
 * MaAI's bc_2type.
 */
export type BackchannelKind = 'continuer' | 'assessment'
/** What the decision rested on: the backchannel model alone, a clause boundary in the text alone, or both together. */
export type BackchannelSource = 'model' | 'text' | 'both'

/** One listening aizuchi, recorded to compute the hit rate, the share after which the user kept talking. */
export interface ListeningAizuchi {
  kind: BackchannelKind
  source: BackchannelSource
  /** Milliseconds since capture started. */
  atMs: number
  /** The user spoke again afterwards, so the aizuchi landed in a mid-sentence pause. */
  continued: boolean
}

/**
 * How the end of an utterance was decided. `early` means VAP's EoT stayed high and confirmed it
 * early, `extended` means a low EoT stretched the wait, and `fixed` means the configured hangover was
 * used, because VAP was not ready, was stale, or sat in between.
 */
export type HangoverMode = 'early' | 'extended' | 'fixed'

export interface TurnTimings {
  /** How long detecting the end of the utterance took, that is the hangover. */
  vadMs?: number
  /** Which path of the dynamic hangover that decision took, which is what the EoT statistics count. */
  vadMode?: HangoverMode
  /** How long the final transcription took. */
  asrMs?: number
  /** From the end of the utterance until the aizuchi clip really started playing. */
  aizuchiMs?: number
  /** The length of the aizuchi clip. The silence between its end and the real answer is e2eMs - aizuchiMs - aizuchiClipMs. */
  aizuchiClipMs?: number
  /** From the end of the utterance until the bridge really started playing, and its length. Present only when a bridge played. */
  bridgeMs?: number
  bridgeClipMs?: number
  /** How the bridge ended: `played`, `late` when the real answer arrived first, or `failed` when generating or synthesizing it failed. */
  bridge?: BridgeOutcome
  /** From the start of the turn to the first text delta. */
  ttftMs?: number
  /** How long synthesizing the first sentence took. */
  ttsMs?: number
  /** From the end of the utterance until the first segment could play, that is end to end. */
  e2eMs?: number
  /** The usage of every round of the turn, summed. The cache hit rate is cacheRead / (input + cacheRead + cacheCreation). */
  inputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  outputTokens?: number
  /** The total input of the last round, that is the context length actually sent in this turn. */
  contextTokens?: number
  /** How many rounds called the API. */
  rounds?: number
  /** How many client tools were called. */
  toolCalls?: number
  /** The stream dropped after the reply had started and was resumed with a request to continue. */
  resumed?: boolean
  /** The context was over the limit, so a compaction started in the background before the request went out. */
  compacted?: boolean
  /** How many memories the look-ahead injected and roughly how many tokens they took. Zero means the search found nothing. */
  injectedMemories?: number
  injectedTokens?: number
  /** How long the search for those memories took, including computing the embedding. Without an embedding only FTS runs. */
  memorySearchMs?: number
  /** Why the cache missed in the first round, compared with the previous request. */
  cacheMissReason?: CacheMissReason
  /** The listening aizuchi played while this utterance was captured. It is omitted when there were none. */
  listening?: ListeningAizuchi[]
  /** How often a short sound from the user was heard as an aizuchi during this turn's speech and did not stop it. */
  userBackchannels?: number
  /** How often the user's voice stopped this turn's speech. */
  bargeIns?: number
}

export type BridgeOutcome = 'played' | 'late' | 'failed'

/** The usage of one round, the four numbers taken from the provider's own usage report. */
export interface RoundUsage {
  input: number
  cacheRead: number
  cacheCreation: number
  output: number
  /** The provider-side web searches the response ran, which are billed per search on top of the tokens. */
  webSearches: number
}

/**
 * One user turn as measured and stored in metrics.jsonl. A value that only arrives after the turn is
 * done, such as when playback really began, is appended under the same id with a higher revision, so
 * the last line written for an id is the complete measurement of that turn.
 */
export interface TurnMetricLog extends TurnTimings {
  /** The renderer's clientRequestId, which stays unique across restarts of the app. */
  id: string
  /** It starts at 1 and rises with every append. */
  revision: number
  /** When the turn's input was accepted, in epoch milliseconds. Every revision under an id repeats this value. */
  occurredAt: number
  /** Typed input, which is left out of the end-to-end voice measurements. */
  typed?: boolean
}

export type TurnEvent =
  | {
      type: 'started'
      turnId: number
      /**
       * `user` is input from the renderer, `interject` is an interruption such as a job report, and
       * `live` is a turn the live engine started, through delegation or function calling.
       */
      origin: 'user' | 'interject' | 'live'
      /** Matches the start request the renderer issued. It is set on user turns only. */
      requestId?: string
    }
  | { type: 'segment'; turnId: number; segment: SpeechSegment }
  /** The next mono samples of the streamed segment `index`. `last` closes the segment, and its `samples` may be empty. */
  | { type: 'segmentAudio'; turnId: number; index: number; samples: Float32Array; last: boolean }
  | { type: 'delta'; turnId: number; text: string }
  | {
      type: 'tool'
      turnId: number
      name: string
      status: 'start' | 'done' | 'error'
      detail?: string
    }
  | { type: 'panel'; turnId: number; event: PanelEvent }
  /** Opens a mini app for open_app; null closes the open one and leaves the conversation alone on screen. */
  | { type: 'app'; turnId: number; open: MiniAppTarget | null }
  | { type: 'metrics'; turnId: number; timings: TurnTimings }
  | { type: 'done'; turnId: number; fullText: string }
  /**
   * Why the turn failed: the message of an error as it was thrown, key and all, which the renderer words when it
   * shows it, or the sentence the assistant said in place of a reply.
   */
  | { type: 'error'; turnId: number; message: string }

/** Whether the renderer really started the interject audio or discarded it before it began. */
export type TurnPlaybackAckStatus = 'started' | 'interrupted'

export interface TurnStartOptions {
  /** An id the renderer issues, so the IPC reply and the events can be matched whichever arrives first. */
  clientRequestId?: string
  /** The text of the aizuchi played at the end of the utterance, given to the brain so it can speak on from there. */
  aizuchi?: string
  /** The bridge to place before the real answer, when the look-ahead has settled on its wording. */
  bridge?: string
  /** The wording of the bridge is not settled yet and the look-ahead is still running. A short phrase reusing the user's words is expected. */
  bridgePending?: boolean
  /** The turn came from typed input, with no audio. It is still synthesized, but the end-to-end measurement is skipped. */
  typed?: boolean
}

/** The connection state of a live session. `idle` means the engine is running but the session is closed because the conversation stopped. */
export type LiveConnection = 'off' | 'idle' | 'connecting' | 'open' | 'error'

/** Live usage. GPT-Live is priced from the seconds a session is open and Gemini from the seconds of audio in and out. */
export interface LiveUsage {
  /** The total seconds sessions have been open since the microphone was switched on. */
  sessionSeconds: number
  /** The estimated cost in USD. */
  costUsd: number
}

/**
 * What the live engine in main reports to the renderer. The audio itself arrives separately through
 * onLiveAudio. A transcript arrives while it is still forming, and `final` settles one utterance. Under
 * Gemini Live that is when it goes into the conversation log, and `turnId` is the turn it belongs to.
 * GPT-Live sends only the user's transcript, whose `turnId` names its line on screen; brain records the
 * utterance with the turn it is handed to.
 */
export type LiveEvent =
  | { type: 'connection'; state: LiveConnection; detail?: string }
  | { type: 'userTranscript'; turnId: number; text: string; final: boolean }
  | { type: 'assistantTranscript'; turnId: number; text: string; final: boolean }
  /** The user's voice stopped the model from speaking, and the renderer drops the audio waiting to play. */
  | { type: 'interrupted' }
  /** Milliseconds from the end of the user's utterance to the first audio that arrived. */
  | { type: 'latency'; responseMs: number; connectMs?: number }
  | { type: 'usage'; usage: LiveUsage }
  /** The message of an error as it was thrown, key and all, which the renderer words when it shows it. */
  | { type: 'error'; message: string }

export interface LiveStartResult {
  ok: boolean
  reason?: string
}

export type PanelSlot = 'left' | 'right'
export type PanelState = 'skeleton' | 'loading' | 'ready' | 'error' | 'stale'

export interface PanelSpec {
  /** The key an upsert matches on, such as "weather:東京". */
  key: string
  /** The panel type, as the catalog names it. */
  type: string
  slot: PanelSlot
  state: PanelState
  props: Record<string, unknown>
  /** What the card shows as its source, such as the name of the API, a time zone or how many files it read. */
  source?: string
  /** Milliseconds from the last update until the panel turns stale. Without it the panel never expires on its own. */
  ttl?: number
  /** When the panel turned stale, which the renderer's lifecycle uses. */
  staleAt?: number
  /** The failure as the error's own message, which the card words in the language of the interface. */
  error?: string
  /** The turn that owns the panel, so the renderer can clean up panels a finished turn left unfinished. */
  ownerTurnId?: number
  createdAt: number
  updatedAt: number
}

export type PanelEvent =
  | {
      op: 'create'
      replacesKey?: string
      key: string
      type: string
      slot: PanelSlot
      props: Record<string, unknown>
      state?: PanelState
      source?: string
      ttl?: number
    }
  | {
      op: 'patch'
      key: string
      props?: Record<string, unknown>
      state?: PanelState
      source?: string
      error?: string
      ttl?: number
    }
  | { op: 'dismiss'; key: string }

export type TimerStatus = 'active' | 'finished'
export type TimerNotificationStatus = 'pending' | 'delivered'

/** A timer owned by the main process and persisted under userData. */
export interface AppTimer {
  id: string
  label: string
  seconds: number
  createdAt: number
  endsAt: number
  status: TimerStatus
  finishedAt?: number
  /** Where a finished timer stands in the notification outbox. An active timer does not carry it. */
  notificationStatus?: TimerNotificationStatus
}

export interface TimerCreateRequest {
  /** The PanelSpec key. Creating the same id again returns the existing timer. */
  id: string
  label?: string
  seconds: number
}

export type TimerEvent =
  | { type: 'updated'; timer: AppTimer }
  | { type: 'removed'; id: string }

export type JobStatus = 'running' | 'stopping' | 'done' | 'error' | 'cancelled'

/** The agent CLI that runs a job. */
export type AgentEngine = 'codex' | 'claude'

/**
 * Whether an engine's CLI was found. 'script-only' is a Windows install that left only a .cmd or .bat
 * script, as npm does, which ASIST does not start: cmd.exe would parse the quotes and parentheses in
 * the arguments again. 'sandbox-not-set-up' is a Windows codex whose own sandbox has not been set up,
 * without which ASIST does not run it: codex there would not confine a job at all.
 */
export type AgentCliState = 'found' | 'missing' | 'script-only' | 'sandbox-not-set-up'

export interface AgentProcessIdentity {
  pid: number
  startedAt: string
  token: string
}

export interface AgentJob {
  id: string
  title: string
  prompt: string
  cwd: string
  readonly: boolean
  engine: AgentEngine
  status: JobStatus
  /** The CLI starts only after the job has been persisted, and the worktree is left alone until the process is confirmed to have ended. */
  processIdentity?: AgentProcessIdentity
  startedAt: number
  endedAt?: number
  /** The summary written when the job finished. It is also what the voice reports. */
  summary?: string
  /** How many turns the job used. */
  numTurns?: number
  costUsd?: number
  /** The absolute paths of the files the job created or edited, which show_file can display. */
  artifacts?: string[]
  /** The engine's session id, claude's session_id or codex's thread_id. continue_agent_job resumes that same session. */
  sessionId?: string
  /** The job this one continues. */
  parentId?: string
  /**
   * Where a job writing into a git repository is isolated, so the user's repository is untouched until the merge.
   * `dir` is the worktree's path, and `cwd` is the folder the user named, at the same place inside it. `base` is
   * the commit the job started from. `submodules` are the submodules, with .gitmodules, that the job touched,
   * as found when it settled; ASIST does not merge such a job, and its worktree waits for the user.
   */
  worktree?: { repo: string; dir: string; branch: string; base: string; commit?: string; submodules?: string[] }
  /** Where the worktree stands between review and merge. `unchanged` is only for a job that committed cleanly and left nothing a merge would take in. */
  mergeState?: JobMergeState
  /** The day memory curation covered and whether the follow-up has been applied. A continuation job inherits the day, and the voice does not report it. */
  memoryCuration?: { through: string | null; applied: boolean }
}

export type JobMergeState = 'pending' | 'merged' | 'discarded' | 'unchanged' | 'conflict' | 'error'

/**
 * The branch checked out in the repository, which a merge goes into, or null when HEAD is not on a branch,
 * and why ASIST refuses to merge, as an error text, or null when it merges. A merge refuses to go on once
 * another branch is checked out, since a branch cut from the same commit keeps the merge base.
 */
export type MergeVerdict = { into: string; blocked: null } | { into: string | null; blocked: string }

export type JobDiff = MergeVerdict & {
  commit: string
  /**
   * The merge base with the repository's HEAD the diff counts from. The merge refuses to go on when it has
   * changed, since it would then apply changes the diff did not show.
   */
  base: string
  stat: string
  patch: string
  /**
   * The submodules the job touched and those whose folders in the worktree may hold work now, which keep
   * ASIST from merging it (see `AgentJob.worktree.submodules`).
   */
  submodules: string[]
}

/** What the user saw and approved in a review, which a merge carries so that main merges only that. */
export type ReviewedMerge = Pick<JobDiff, 'commit' | 'base' | 'into'>

/** What a discard of a job would delete, read when it is asked about. */
export interface DiscardPreview {
  repo: string
  dir: string
  branch: string
  /** What a merge of the branch would have brought in, as git's stat. */
  stat: string
  /**
   * The submodules whose work in the worktree the discard may delete, as submodulesWithWork finds them now.
   * Empty when the worktree's folder is gone.
   */
  submodules: string[]
}

/**
 * One line of a job log. A CLI event is kept in its own shape and only the display side turns it into
 * text. `system` is ASIST's own record of the launch command, the write access and the merge, and
 * `stderr` is the CLI's standard error.
 */
export type JobLogEvent = AgentStreamEvent | { kind: 'system'; text: string } | { kind: 'stderr'; text: string }

export interface JobLogLine {
  t: number
  event: JobLogEvent
}

export type JobEvent =
  | { type: 'update'; job: AgentJob }
  | { type: 'log'; id: string; line: JobLogLine }

/** `section` is a heading on a page about the user, a person, a place or a topic; `journal` is a heading in ASIST's own diary. */
export type MemoryUnitKind = 'section' | 'journal'

/** A searchable item built from the Markdown under userData/memory/. Search results reach the conversation in this type too. */
export interface MemoryUnit {
  id: string
  /** The path relative to the memory directory. */
  file: string
  /** The line of the section heading or of the item, counted from 1. */
  line: number
  kind: MemoryUnitKind
  /** The page's name: the filename for a page, "ユーザー" for the user's own page, and the date for a journal. */
  page: string
  heading: string
  aliases: string[]
  /** The body of the section or of the item. */
  text: string
  /** The date of the source: the file's date for a journal and `updated` for a page. It is empty when there is none. */
  date: string
  /** The position of the section within its page. Section 0 is the summary, which is always returned on an exact name match. */
  order: number
}

/**
 * The documents the memory screen reads and writes: a page about a person, a place or a topic, a
 * journal entry, the assistant's own page me.md, the user's page user.md and the summary
 * profile.md.
 */
export type MemoryDocumentKind = 'instruction' | 'me' | 'user' | 'page' | 'journal'

export interface MemoryDocument {
  /** The path relative to the memory directory. */
  file: string
  kind: MemoryDocumentKind
  /** The page's name, the date, or one of "いつも覚えておくこと", "私について" and "ユーザー". */
  title: string
  aliases: string[]
  /** The `updated` field of the frontmatter. For a journal it is that entry's date. */
  updated: string | null
  headings: string[]
  /** The first sentence under the first heading, which is the summary. */
  summary: string
}

/** A new page. Its name becomes the filename. */
export interface MemoryPageInput {
  name: string
}

/** The overview of the memory shown on the settings screen. */
export interface MemoryOverview {
  dir: string
  units: number
  pages: number
  /** The day up to which the curation job has processed, as YYYY-MM-DD. */
  curatedThrough: string | null
  /** A curation job that is running or waiting to be merged. */
  pendingJobId: string | null
  /** The last curation that failed since the last one that succeeded, with why. */
  lastFailure: { at: number; message: string } | null
  unavailableReason: string | null
}

/**
 * The state of a provider's API key. `verified` means the key currently in the environment
 * authenticated against the real API within this process; validating on save and a successful model
 * lookup reach it, and replacing the key drops back to `saved`. `unreadable` is a saved key that this
 * build cannot decrypt, such as one saved by the development build, and it has to be entered again.
 */
export type ApiKeyState = 'missing' | 'saved' | 'verified' | 'unreadable'

/** Whether the state is of a key the app can read and send. A missing key and one this build cannot decrypt are not. */
export const keyReadable = (state: ApiKeyState): boolean => state === 'saved' || state === 'verified'

export interface AppStatus {
  /** Whether both the conversation model and the bridge phrase model could be fetched from the real API with their providers' keys. */
  llm: boolean
  conversationModel: ConversationModel
  llmKeys: Record<LlmProvider, ApiKeyState>
  tts: boolean
  ttsEngine: TtsEngine
  ttsLabel: string
  /** Whether the local speech recognition model answers. */
  asr: boolean
  /**
   * Whether the selected speech recognition model and its runtime are installed, so that the server can be
   * started. While it is true and `asr` is false, the server is still starting; while it is false, it never will.
   */
  asrInstalled: boolean
  /** Whether the CLI of the selected agent engine was found. */
  agent: AgentCliState
  agentEngine: AgentEngine
  /** The voice engine from the settings. With `live` the ASR and TTS states are not used. */
  voiceEngine: VoiceEngine
  live: LiveConnection
}

/** What first-time setup shows about installation progress, as opposed to plain liveness. */
export interface SetupStatus {
  services: AppStatus
  /** The local speech recognition, or null on a machine that has no runtime for it. */
  asr: {
    selectedModel: AsrModel
    resolvedModel: ResolvedAsrModel
    recommendedModel: ResolvedAsrModel
    label: string
    /** The memory the recommendation is decided from: the Mac's own on mlx, the GPU's on cuda. */
    totalMemoryGb: number
    runtimeInstalled: boolean
    modelInstalled: boolean
    /** What preparing the resolved model downloads: the environment and the model, less what is installed. */
    downloadGb: number
    ready: boolean
  } | null
  /** The local Qwen3-TTS model. `recommended` is whether this Mac has the memory to run it beside the speech recognition. */
  qwenTts: {
    label: string
    recommended: boolean
    runtimeInstalled: boolean
    modelInstalled: boolean
    ready: boolean
  }
}

export interface SetupProgress {
  status: 'downloading' | 'done' | 'error' | 'cancelled'
  pct: number
  downloadedMb: number
  totalMb: number
  message?: string
}

/** The colours of the window buttons the OS draws over the page, taken from the theme. */
export interface WindowControlColors {
  /** A CSS colour for the symbols on the buttons. */
  symbol: string
}

/** The global hotkey: off in the settings, registered with the OS, or refused because another application holds it. */
export type HotkeyStatus = 'off' | 'registered' | 'failed'

/** How setup finishes: speech recognized by the server or in the browser, typed text, or a live engine that listens and speaks itself. */
export type SetupVoiceMode = 'server' | 'local' | 'text' | LiveEngine

/** The choices the renderer re-checked just before the finish button. The main process validates the external services again. */
export interface CompleteSetupRequest {
  voiceMode: SetupVoiceMode
  micAutoStart: boolean
  /** True when getUserMedia obtained a real stream and every track has been stopped again. */
  microphoneVerified: boolean
  /** True only when the renderer's ASR worker could initialize the selected model. */
  localAsrVerified: boolean
  /** True when the browser bridge to the macOS system TTS can run. */
  systemTtsVerified: boolean
}

export const IpcChannel = {
  Status: 'status',
  StatusChanged: 'status-changed',
  RequestMicPermission: 'request-mic-permission',
  MicNativeStart: 'mic-native-start',
  MicNativeStop: 'mic-native-stop',
  MicNativeFrame: 'mic-native-frame',
  MicNativeStatus: 'mic-native-status',
  VapStart: 'vap-start',
  VapPush: 'vap-push',
  VapState: 'vap-state',
  VapStatus: 'vap-status',
  VapPrepare: 'vap-prepare',
  VapPrepareCancel: 'vap-prepare-cancel',
  EmbeddingStatus: 'embedding-status',
  EmbeddingPrepare: 'embedding-prepare',
  EmbeddingPrepareCancel: 'embedding-prepare-cancel',
  Transcribe: 'transcribe',
  TranscribeCancel: 'transcribe-cancel',
  TranscribePartial: 'transcribe-partial',
  TurnStart: 'turn-start',
  TurnAbort: 'turn-abort',
  TurnEvent: 'turn-event',
  TurnInterject: 'turn-interject',
  TurnPlaybackAck: 'turn-playback-ack',
  LiveStart: 'live-start',
  LiveStop: 'live-stop',
  LivePush: 'live-push',
  LiveActivity: 'live-activity',
  LiveText: 'live-text',
  LiveAudio: 'live-audio',
  LiveEvent: 'live-event',
  PanelFetch: 'panel-fetch',
  PanelEventPush: 'panel-event-push',
  TimerList: 'timer-list',
  TimerCancel: 'timer-cancel',
  TimerEvent: 'timer-event',
  AizuchiBank: 'aizuchi-bank',
  BridgePlan: 'bridge-plan',
  BridgeClip: 'bridge-synthesize',
  AizuchiClassify: 'aizuchi-classify',
  AizuchiClassifierStatus: 'aizuchi-classifier-status',
  AizuchiClassifierPrepare: 'aizuchi-classifier-prepare',
  AizuchiClassifierPrepareCancel: 'aizuchi-classifier-prepare-cancel',
  JobCancel: 'job-cancel',
  JobMerge: 'job-merge',
  JobDiscard: 'job-discard',
  JobDiscardPreview: 'job-discard-preview',
  JobDiff: 'job-diff',
  JobList: 'job-list',
  JobLog: 'job-log',
  JobEvent: 'job-event',
  MetricsLog: 'metrics-log',
  MemoryDocuments: 'memory-documents',
  MemoryDocumentRead: 'memory-document-read',
  MemoryDocumentWrite: 'memory-document-write',
  MemoryDocumentCreate: 'memory-document-create',
  MemoryDocumentDelete: 'memory-document-delete',
  MemoryOverview: 'memory-overview',
  MemoryCurate: 'memory-curate',
  TasksList: 'tasks-list',
  TaskCreate: 'task-create',
  TaskUpdate: 'task-update',
  TaskMove: 'task-move',
  TaskRemove: 'task-remove',
  TasksClearDone: 'tasks-clear-done',
  TasksChanged: 'tasks-changed',
  NotesList: 'notes-list',
  NotesSearch: 'notes-search',
  NoteRead: 'note-read',
  NoteCreate: 'note-create',
  NoteWrite: 'note-write',
  NoteRemove: 'note-remove',
  NotesChanged: 'notes-changed',
  Notify: 'notify',
  HotkeyMic: 'hotkey-mic',
  GetSetupStatus: 'get-setup-status',
  CompleteSetup: 'complete-setup',
  AsrPrepare: 'asr-prepare',
  AsrPrepareCancel: 'asr-prepare-cancel',
  TtsPrepare: 'tts-prepare',
  TtsPrepareCancel: 'tts-prepare-cancel',
  SetupProgress: 'setup-progress',
  CalendarStatus: 'calendar-status',
  CalendarRequestAccess: 'calendar-request-access',
  CalendarSignOut: 'calendar-sign-out',
  CalendarEvents: 'calendar-events',
  CalendarChange: 'calendar-change',
  CalendarOpenGuide: 'calendar-open-guide',
  CalendarOpenPrivacy: 'calendar-open-privacy',
  TtsVerify: 'tts-verify',
  MicOpenPrivacy: 'mic-open-privacy',
  AppVersion: 'app-version',
  GetPlatformCapabilities: 'get-platform-capabilities',
  HotkeyStatus: 'hotkey-status',
  PaintWindowControls: 'paint-window-controls',
  LicensesOpen: 'licenses-open',
  AppUpdateState: 'app-update-state',
  AppUpdateChanged: 'app-update-changed',
  AppUpdateInstall: 'app-update-install',
  ApiUsage: 'api-usage',
  LogsOpenFolder: 'logs-open-folder',
  FolderChoose: 'folder-choose',
  MailStatus: 'mail-status',
  MailProbe: 'mail-probe',
  MailAccountAdd: 'mail-account-add',
  MailAccountUpdate: 'mail-account-update',
  MailAccountRemove: 'mail-account-remove',
  MailList: 'mail-list',
  MailThread: 'mail-thread',
  MailRead: 'mail-read',
  MailChange: 'mail-change',
  MailReplySettle: 'mail-reply-settle',
  MailReplySend: 'mail-reply-send',
  MailSyncNow: 'mail-sync-now',
  MailOpenGuide: 'mail-open-guide',
  MailEvent: 'mail-event',
  MailDraftList: 'mail-draft-list',
  MailDraftCreate: 'mail-draft-create',
  MailDraftUpdate: 'mail-draft-update',
  MailDraftRemove: 'mail-draft-remove',
  MailDraftSend: 'mail-draft-send',
  ConfirmEvent: 'confirm-event',
  ConfirmPending: 'confirm-pending',
  ConfirmResolve: 'confirm-resolve',
  GetSettings: 'get-settings',
  SaveSettings: 'save-settings',
  SaveApiKey: 'save-api-key',
  VerifySavedApiKey: 'verify-saved-api-key',
  ListSpeakers: 'list-speakers',
  TtsTest: 'tts-test',
  OpenExternal: 'open-external',
  RevealPath: 'reveal-path',
  MiniAppView: 'mini-app-view'
} as const

export interface RendererApi {
  getStatus(): Promise<AppStatus>
  /** Subscribes to the status pushed by the liveness checks, such as the speech recognition or the TTS dying and coming back. */
  onStatusChanged(callback: (status: AppStatus) => void): () => void
  requestMicPermission(): Promise<boolean>
  /**
   * Starts microphone capture through the native helper that cancels the echo. When it reports
   * ok, 48 kHz mono Float32 frames arrive at onMicNativeFrame; when it does not, the caller has to
   * fall back to getUserMedia.
   */
  micNativeStart(): Promise<NativeMicStartResult>
  micNativeStop(): Promise<void>
  onMicNativeFrame(callback: (frame: Float32Array) => void): () => void
  /** Reports that the helper stopped, for instance because the device disappeared. Recovering is up to the caller. */
  onMicNativeStatus(callback: (status: NativeMicStatus) => void): () => void

  /**
   * Starts the VAP worker, returning true at once when it already runs. On false the app keeps
   * running on the heuristics, so this fails open. The model stays resident and is not stopped when
   * the microphone goes off.
   */
  vapStart(): Promise<boolean>
  /** Pushes 16 kHz two-channel audio to the worker, ch0 being the microphone and ch1 the TTS. */
  vapPush(user: Float32Array, assistant: Float32Array): Promise<void>
  onVapState(callback: (state: VapState) => void): () => void
  vapStatus(): Promise<VapStatus>
  /** Prepares the Python environment and the models for VAP. Progress arrives through onSetupProgress. */
  vapPrepare(): Promise<{ ok: boolean; message: string }>
  vapPrepareCancel(): Promise<boolean>
  embeddingStatus(): Promise<EmbeddingStatus>
  /** Prepares the Python environment and the model for the memory embedding. Progress arrives through onSetupProgress. */
  embeddingPrepare(): Promise<{ ok: boolean; message: string }>
  embeddingPrepareCancel(): Promise<boolean>
  /** The final transcription, through the speech recognition model on this Mac. */
  transcribe(samples: Float32Array, requestId: string): Promise<string>
  /** Aborts a final transcription by its requestId, whether it has started or not. */
  transcribeCancel(requestId: string): Promise<boolean>
  /** Transcribes the buffer mid-utterance, with a short timeout, and returns an empty string on failure. */
  transcribePartial(samples: Float32Array): Promise<string>

  /** Starts a turn and returns its turnId. Everything that follows arrives through onTurnEvent. */
  turnStart(text: string, options?: TurnStartOptions): Promise<number>
  turnAbort(turnId: number): Promise<void>
  onTurnEvent(callback: (event: TurnEvent) => void): () => void
  /** Asks for an interrupting utterance, such as a report that a job has finished. */
  interject(text: string): Promise<void>
  /** Tells main whether the interject reached real playback or was discarded before it started. */
  turnPlaybackAck(turnId: number, status: TurnPlaybackAckStatus): Promise<void>

  /**
   * Wakes the live engine named by the `voiceEngine` setting. The session opens when the user starts
   * speaking and closes when the conversation stops. On `ok` false the reason is returned, for
   * example that no key is configured or that the engine is set to cascade.
   */
  liveStart(): Promise<LiveStartResult>
  liveStop(): Promise<void>
  /** Pushes the microphone's 16 kHz mono Float32 frames, for as long as the microphone is on. */
  livePush(samples: Float32Array): Promise<void>
  /** The renderer's VAD caught a human voice or lost it, which is the signal to open the session. */
  liveActivity(active: boolean): Promise<void>
  /** Typed input. On GPT-Live the brain answers and the voice side reads it out; on Gemini it is sent as a text turn. */
  liveText(text: string): Promise<void>
  /** The live model's audio, 24 kHz mono Float32, to be played in the order it arrives. */
  onLiveAudio(callback: (samples: Float32Array) => void): () => void
  onLiveEvent(callback: (event: LiveEvent) => void): () => void

  /** Fetches a built-in panel's data through the fetcher in main and returns the completed props. */
  panelFetch(
    type: string,
    props: Record<string, unknown>
  ): Promise<{ props: Record<string, unknown>; source?: string }>
  /** Subscribes to panel events that originate in main, such as a job's progress. */
  onPanelEvent(callback: (event: PanelEvent) => void): () => void

  /** The persistent timers owned by main. They expire whether or not their panel is mounted. */
  timerList(): Promise<AppTimer[]>
  timerCancel(id: string): Promise<boolean>
  onTimerEvent(callback: (event: TimerEvent) => void): () => void

  /** The bank of aizuchi synthesized at startup. */
  aizuchiBank(): Promise<AizuchiClip[]>
  /** The look-ahead on a fast model. It is called on every update of the partial transcript, and the last result before the utterance ends is used. */
  bridgePlan(input: { text: string; lastAssistantText: string }): Promise<BridgePlan>
  /** Synthesizes the bridge phrase. */
  bridgeSynthesize(text: string): Promise<BridgeClip>
  /**
   * Runs the partial transcript through the aizuchi classifier, and throws when the worker is not
   * running. Calls have to go one at a time, which the renderer's AizuchiClassifierFeed ensures by
   * holding back all but the newest input.
   */
  aizuchiClassify(input: { prev: string; text: string }): Promise<AizuchiClassification>
  aizuchiClassifierStatus(): Promise<AizuchiClassifierStatus>
  /** Prepares the Python environment and the model for the aizuchi classifier. Progress arrives through onSetupProgress. */
  aizuchiClassifierPrepare(): Promise<{ ok: boolean; message: string }>
  aizuchiClassifierPrepareCancel(): Promise<boolean>

  /** Sends the latencies measured for a finished turn to main, which appends them to metrics.jsonl. */
  metricsLog(metrics: TurnMetricLog): Promise<void>

  /** The documents on the memory screen: "私について", "要点", "ユーザー", the pages, and the journal with the newest day first. */
  memoryDocuments(): Promise<MemoryDocument[]>
  /** The document's markdown, or null when there is none. */
  memoryDocumentRead(file: string): Promise<string | null>
  /**
   * Replaces a document wholesale, and a save becomes a commit. `base` is the markdown the screen read
   * before editing; the save throws when the document has changed since, and with the reason when the
   * markdown breaks the writing rules.
   */
  memoryDocumentWrite(file: string, markdown: string, base: string): Promise<MemoryDocument>
  /** Creates a new page from the template. */
  memoryDocumentCreate(input: MemoryPageInput): Promise<MemoryDocument>
  /** Deletes a page or a journal entry. A page talked about on a day not curated yet can be written again by the next curation. */
  memoryDocumentDelete(file: string): Promise<void>
  memoryOverview(): Promise<MemoryOverview>
  /** Starts the curation job, an Agent job, right away. When it finishes it is a job either waiting to be merged or already merged. */
  memoryCurate(): Promise<AgentJob | null>

  /** Tasks are persisted atomically in main, which returns the task it changed. The full list arrives through onTasksChanged. */
  tasksList(): Promise<Task[]>
  taskCreate(input: TaskInput): Promise<Task>
  taskUpdate(id: string, patch: TaskPatch): Promise<Task>
  taskMove(move: TaskMove): Promise<Task>
  taskRemove(id: string): Promise<Task>
  tasksClearDone(): Promise<number>
  /** Every task, once main's save has committed. */
  onTasksChanged(callback: (tasks: Task[]) => void): () => void

  /** Every note, newest change first. */
  notesList(): Promise<NoteSummary[]>
  /** The notes containing every word of the query, newest change first. */
  notesSearch(query: string): Promise<NoteSummary[]>
  noteRead(id: string): Promise<string>
  noteCreate(markdown: string): Promise<NoteSummary>
  noteWrite(id: string, markdown: string): Promise<NoteSummary>
  /** Moves the note's file to the macOS Trash. */
  noteRemove(id: string): Promise<void>
  /** Every note, once a change has been written. */
  onNotesChanged(callback: (notes: NoteSummary[]) => void): () => void

  /** A notification in Notification Center, for instance when a timer expires. */
  notify(title: string, body: string): Promise<void>
  /** Tells main which mini app is open and what it shows, or null when none is; sent on every change. */
  reportMiniAppView(view: MiniAppView | null): Promise<void>
  /** The request to toggle the microphone, from the global hotkey or the tray. */
  onHotkeyMic(callback: () => void): () => void

  getSetupStatus(): Promise<SetupStatus>
  /** Validates the chosen API, ASR and TTS again, and marks onboarding complete only when they all pass. */
  completeSetup(request: CompleteSetupRequest): Promise<AppSettings>
  prepareAsrModel(model?: AsrModel): Promise<{ ok: boolean; message: string }>
  cancelAsrPreparation(): Promise<boolean>
  /** Installs the MLX runtime if needed and downloads the Qwen3-TTS model, about 1.9 GB. Progress arrives through onSetupProgress. */
  prepareTtsModel(): Promise<{ ok: boolean; message: string }>
  cancelTtsPreparation(): Promise<boolean>
  onSetupProgress(callback: (p: SetupProgress) => void): () => void

  jobCancel(id: string): Promise<void>
  /** Merges the worktree's changes into the user's repository, or discards them. The diff is what the user reviews before merging. */
  jobMerge(id: string, reviewed: ReviewedMerge): Promise<void>
  jobDiscard(id: string): Promise<void>
  /** What jobDiscard would delete, so that a screen can ask before throwing away work it does not show. */
  jobDiscardPreview(id: string): Promise<DiscardPreview>
  jobDiff(id: string): Promise<JobDiff>
  jobList(): Promise<AgentJob[]>
  jobLog(id: string): Promise<JobLogLine[]>
  onJobEvent(callback: (event: JobEvent) => void): () => void

  calendarStatus(): Promise<CalendarStatus>
  /** Asks macOS for access to EventKit, or signs in to Google through the browser unless it already has. */
  calendarRequestAccess(): Promise<CalendarStatus>
  /** Takes back ASIST's access to Google Calendar. Only the Google calendar has a sign-in of ASIST's own. */
  calendarSignOut(): Promise<CalendarStatus>
  /** The events in the range the calendar screen shows, at most 62 days, read only from the calendars chosen in the settings. */
  calendarEvents(range: CalendarListRange): Promise<CalendarEvent[]>
  /** Adds, changes or deletes an event. It is saved only when the user approves it in the in-app confirmation. */
  calendarChange(change: CalendarChange): Promise<CalendarChangeResult>
  calendarOpenGuide(): Promise<void>
  calendarOpenPrivacy(): Promise<void>
  /**
   * Checks whether the selected speech engine can be reached. When VOICEVOX or AivisSpeech is in the
   * Applications folder it is launched in the background and the status is returned only once it
   * answers; when it is not installed, `tts` stays false.
   */
  ttsVerify(): Promise<AppStatus>
  /** Opens Privacy & Security > Microphone in System Settings. */
  micOpenPrivacy(): Promise<void>
  /** Opens the folder of the app's log files, the per-day files under ~/Library/Logs, in Finder. */
  logsOpenFolder(): Promise<void>
  /** Asks for a folder with the system's dialog, opened at `startAt` when that exists. Null when the dialog is dismissed. */
  folderChoose(startAt?: string): Promise<string | null>

  /** The state of the mail connection and the number of unread messages in the inbox. */
  mailStatus(): Promise<MailStatus>
  /** Connects with the entered server and password to find the folders such as Sent. It saves nothing. */
  mailProbe(input: MailAccountInput): Promise<MailProbeResult>
  /** Connects to check, then encrypts and stores the password and adds the account to the settings. */
  mailAccountAdd(input: MailAccountInput): Promise<MailAccount>
  /** Omitting `patch` re-enters only the password. A password is stored only after connecting with the new value. */
  mailAccountUpdate(id: string, patch: MailAccountPatch | undefined, password?: string): Promise<MailAccount>
  /** Removes the settings, the password and the downloaded mail together. */
  mailAccountRemove(id: string): Promise<void>
  /** The downloaded messages of every account, newest first. */
  mailList(query: MailListQuery): Promise<MailListResult>
  mailThread(accountId: string, threadId: string): Promise<MailMessage[]>
  /** One message with its body, fetched from the server when it was not downloaded yet. It does not mark the message read. */
  mailRead(id: string): Promise<MailMessageBody>
  /**
   * Sends, archives, trashes, marks read or stars. Pressing the button on screen is the approval for a
   * send, while trashing goes through the confirmation screen. A reply goes through mailReplySettle and
   * mailReplySend instead.
   */
  mailChange(change: MailChangeInput): Promise<MailChangeResult>
  /** The reply main settles for the reader's reply form: the To and Cc it shows are those it is sent to. It needs the connection to the server. */
  mailReplySettle(id: string, replyAll: boolean): Promise<MailReply>
  /** Sends the reply mailReplySettle gave, with the body typed below it. Pressing the button is the approval. */
  mailReplySend(input: MailReplySend): Promise<MailChangeResult>
  mailSyncNow(): Promise<void>
  mailOpenGuide(): Promise<void>
  /** A change in the connection state, a download or a change, new mail, and the full list of drafts. */
  onMailEvent(callback: (event: MailEvent) => void): () => void
  /** Drafts are stored by main, and the settled full list arrives as `drafts` in onMailEvent. */
  mailDraftList(): Promise<MailDraft[]>
  mailDraftCreate(input: MailDraftInput): Promise<MailDraft>
  mailDraftUpdate(id: string, patch: MailDraftPatch): Promise<MailDraft>
  mailDraftRemove(id: string): Promise<void>
  /** Sends a draft. Pressing the button is the approval, so no confirmation screen appears, and the draft is removed once it is sent. */
  mailDraftSend(id: string): Promise<MailChangeResult>
  /** The confirmations main asks for, in mail, calendar and agent jobs. `open` shows the screen and `close` takes it away. */
  onConfirmEvent(callback: (event: ConfirmEvent) => void): () => void
  /** The requests main is waiting on, oldest first, whose `open` a page that loaded after them never heard. */
  confirmPending(): Promise<ConfirmRequest[]>
  confirmResolve(id: string, approved: boolean): Promise<void>
  getSettings(): Promise<AppSettings>
  saveSettings(patch: SettingsPatch): Promise<AppSettings>
  /**
   * Validates the provider's API key, saves it encrypted with the Keychain key in userData/api-keys.json, and
   * returns the status afterwards.
   */
  saveApiKey(provider: LlmProvider, key: string): Promise<AppStatus>
  /**
   * Validates the key main already holds for the provider, saved in an earlier session or set in the
   * environment, and returns the status afterwards. A key is verified only in main's memory, so such a key
   * reads as saved until this runs.
   */
  verifySavedApiKey(provider: LlmProvider): Promise<AppStatus>
  listSpeakers(engine?: TtsEngine): Promise<SpeakerOption[]>
  ttsTest(): Promise<SpeechSegment>
  /** Opens a web page in the browser or a mail address in the mail app, and refuses any other link. */
  openExternal(url: string): Promise<void>
  /** Reveals a file in Finder. Only paths belonging to a job are allowed. */
  revealPath(path: string): Promise<void>
  /** The version of the packaged application, which only the main process knows. */
  appVersion(): Promise<string>
  /** What this OS and machine can run, decided once by the main process and the same for the whole run. */
  getPlatformCapabilities(): Promise<PlatformCapabilities>
  /** Whether the global hotkey is off in the settings, registered, or refused by the OS. */
  hotkeyStatus(): Promise<HotkeyStatus>
  /** Colours the window's minimize, maximize and close buttons where the OS draws them over the page. */
  paintWindowControls(colors: WindowControlColors): Promise<void>
  /** Opens THIRD_PARTY_NOTICES.txt, the licenses of ASIST and of everything it bundles, in the default text editor. */
  licensesOpen(): Promise<void>
  appUpdateState(): Promise<AppUpdateState>
  onAppUpdateChanged(callback: (state: AppUpdateState) => void): () => void
  /** Quits and installs the downloaded version now. Without it, macOS installs the version at the next quit. */
  appUpdateInstall(): Promise<void>
  /** The paid API use summed per local day, oldest first. */
  apiUsage(): Promise<UsageDay[]>
}
