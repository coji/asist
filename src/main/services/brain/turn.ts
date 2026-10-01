import type { RoundUsage, TurnStartOptions } from '@shared/ipc'
import type { ConversationMessage, ConversationResult, ConversationStream, SystemLayer } from '@shared/conversation'
import { waitWithAbort, withTimeoutSignal } from '@shared/abort'
import { apiErrorKey, errMessage, isTransientApiError } from '@shared/api-errors'
import type { MessageKey } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import { SegmentAssembler } from '@shared/segmenter'
import { withRetry } from '@shared/retry'
import type { TurnHandle, TurnRunContext } from '@shared/turn-scheduler'
import { summarizeTurnUsage } from '@shared/turn-usage'
import { ToolRoundExecutor, buildToolResultsMessage, type ToolRoundResult } from '@shared/tool-round'
import { buildResumeMessages, resumeAfterDisconnectNote } from '@shared/turn-recovery'
import { buildMemoryInjection, memoryIdsInToolResult, type MemoryInjection } from '@shared/memory-injection'
import { diagnoseCacheMiss, fingerprintRequest, type CacheMissReason } from '@shared/cache-diagnosis'
import { conversationFeatures, fillPrompt, promptText, type ConversationLocale, type PromptText } from '@shared/conversation-locale'
import { marker } from '@shared/conversation-markers'
import { providerKey, streamConversation } from '../llm'
import { LLM_PROVIDER_INFO, type ConversationModel } from '@shared/llm-catalog'
import { translatorIn } from '../i18n'
import { conversationLocale } from '../conversation-locale'
import { getSettings } from '../settings'
import * as agentRunner from '../agent'
import { randomClip as randomAizuchiClip } from '../aizuchi'
import * as memory from '../memory'
import { summarizeToolInput, summarizeToolResult, type NoticeKind } from './conversation-log'
import { openAppNote } from './mini-app-tools'
import { buildSystemLayers } from './prompt'
import { currentSpeechRoute, emit, history, lastRequestFingerprint, noteRequestFingerprint, record, turnScheduler } from './session'
import type { SpeechRoute } from './speech-route'
import {
  executeClientTool,
  SearchCards,
  toolGuide,
  toolRegistry,
  tools,
  type ToolContext,
  type ToolOptions
} from './tools'

/**
 * Turn execution for the conversation engine. It drives the stream of the configured conversation
 * model and the tool round trips, and hands each finished sentence to the speech route, which
 * synthesizes it and emits a segment, or drops it when text-to-speech is off. On every route the text
 * of the reply is what reaches the screen and the conversation log. Differences between providers
 * are absorbed by the adapters in llm/. The pieces around it are prompt for the system prompt, tools
 * for the definitions and their execution, session for the events, history and conversation log, and
 * speech-route. Interjections live in interject and the reports of finished jobs in job-reporting.
 */

const MAX_TOOL_ROUNDS = 6
/** The waits before retrying a transient API error such as 529 Overloaded. The number of attempts is one more than the number of delays. */
const RETRY_DELAYS_MS = [400, 1200]
const API_ROUND_TIMEOUT_MS = 60_000
/**
 * The output limit of one round. It is generous because every provider counts thinking tokens against
 * it; the length of the visible reply is held down by the prompt instead.
 */
const MAX_OUTPUT_TOKENS = 4000

/**
 * The note that tells the model what the user has already heard before the substance of this turn.
 * The backchannel appears only where the conversation has backchannels at all, which is Japanese; in
 * every other language the bridge line stands on its own.
 */
const ALREADY_SPOKEN: Readonly<Record<'aizuchi' | 'bridge' | 'bridgePending' | 'and' | 'note', PromptText>> = {
  aizuchi: { ja: `相槌「{text}」`, en: `the backchannel "{text}"` },
  bridge: { ja: `短い受け「{text}」`, en: `the short line "{text}"` },
  bridgePending: {
    ja: `相手の言葉を使った短い受け(「〜ですね。」の形)`,
    en: `a short line that picks up a word the user has just said`
  },
  and: { ja: `と`, en: ` and ` },
  note: {
    ja: `[注: あなたは本題の前に{spoken}を発話済みとして扱う(すでに、またはこの直後に流れる)。その続きとして自然に話し始めること。同じ語や同じ形の受けで言い直さない。この注記には言及しない]`,
    en: `[Note: treat {spoken} as already spoken before the substance; it is playing now, or it is about to. Start naturally from there, and do not say the same thing again in the same shape. Never mention this note.]`
  }
}

/** Asks for the rest of a reply the output limit cut off. */
const CONTINUE_AFTER_MAX_TOKENS: PromptText = {
  ja: `直前の回答が上限に達した。重複せず、残りの結論だけを短く続けてください。`,
  en: `The reply you were giving hit the output limit. Continue with the conclusion that is left, briefly, and do not repeat yourself.`
}

/** Stands for the job status once it has emptied after the model saw one, which it would otherwise go on reading as current. */
const NO_JOBS: PromptText = {
  ja: `動いているジョブも、最近終わったジョブも無い。`,
  en: `No agent job is running, and none has finished recently.`
}

/**
 * The job status to send with an input, or null when the history already shows the same one. It rides
 * on the input rather than in the system prompt: the messages are cached behind the system prompt, so
 * its running minutes there would send the whole history again on every turn. It is sent only when it
 * changed, so an unchanged list of projects is not repeated turn after turn.
 */
function jobStatusNote(locale: ConversationLocale, block: string | null, shown: string | null): string | null {
  const status = block ?? (shown ? promptText(locale, NO_JOBS) : null)
  const note = status === null ? null : `${marker(locale, 'jobStatus')}\n${status}`
  return note === shown ? null : note
}

/** Ends a turn with a prepared sentence, which is said aloud and therefore read in the language of the conversation. */
class TurnStopError extends Error {
  constructor(readonly key: Extract<MessageKey, 'spoken.replyTooLong' | 'spoken.cannotAnswer' | 'spoken.turnStopped'>) {
    super(key)
    this.name = 'TurnStopError'
  }
}

/** The input of a turn. With `notice` set it is recorded as a notification from the app rather than as something the user said. */
export interface TurnInput {
  text: string
  notice?: NoticeKind
}

/** Leaving `route` out uses the route the settings choose when the turn starts. */
export interface TurnRuntime {
  route?: SpeechRoute
}

export function abortTurn(turnId: number): void {
  turnScheduler.abort(turnId)
}

export function startTurn(text: string, options: TurnStartOptions = {}): number {
  return beginTurn({ text }, options, 'user', false)!.turnId
}

/** Starts a turn. With onlyIfIdle it returns null instead of starting while a user turn is running, which is what job reporting relies on. */
export function beginTurn(
  input: TurnInput,
  options: TurnStartOptions,
  origin: TurnOrigin,
  onlyIfIdle: boolean,
  runtime: TurnRuntime = {}
): TurnHandle | null {
  const run = async ({ turnId, signal, hold }: TurnRunContext): Promise<void> => {
    emit({
      type: 'started',
      turnId,
      origin,
      requestId: options.clientRequestId
    })
    await runTurn(turnId, input, options, signal, hold, runtime.route ?? currentSpeechRoute())
  }
  const handle = onlyIfIdle ? turnScheduler.startIfIdle(run) : turnScheduler.start(run)
  if (!handle) return null
  // runTurn converts errors into user-facing ones itself, but a regression that lets one escape must
  // not become an unhandled rejection.
  void handle.completion.catch((err) => console.error('turn scheduler failed:', errMessage(err)))
  return handle
}

type TurnOrigin = 'user' | 'interject'

async function runTurn(
  turnId: number,
  input: TurnInput,
  options: TurnStartOptions,
  signal: AbortSignal,
  hold: TurnRunContext['hold'],
  route: SpeechRoute
): Promise<void> {
  const userText = input.text
  // The conversation language is read once at the start of the turn, so that every note, the system
  // prompt, the tools, the spoken lines and the voice of this turn keep one language even if the setting
  // changes while it runs.
  const locale: ConversationLocale = conversationLocale()
  const say = translatorIn(locale)
  const recordAssistant = (
    text: string,
    outcome: { interrupted?: 'before-reply' | 'while-speaking'; failed?: boolean } = {}
  ): void => {
    record({
      kind: 'assistant',
      turnId,
      text,
      ...(outcome.interrupted ? { interrupted: outcome.interrupted } : {}),
      ...(outcome.failed ? { failed: true } : {})
    })
  }
  // The notes attached to the utterance. They are stored in the history as well, so that what the
  // model read and what the next turn sends are the same: if the last user message changed on the next
  // turn, the prompt cache would break from there on. They come in this order: typed input and the
  // aizuchi note, prefetched panel data, then memories.
  const contextNotes: string[] = []
  // Typed input is not a transcript, so the model should not assume misrecognitions or missing punctuation.
  if (options.typed && !input.notice) contextNotes.push(marker(locale, 'typedInputNote'))
  // The aizuchi and bridge notes are needed only where the sentences are spoken. claude-sonnet-5 does
  // not support prefilling the assistant message, so the request to continue from there is made on the
  // user side.
  const aizuchiText = route.kind === 'tts' && conversationFeatures(locale).aizuchi ? options.aizuchi?.trim() : undefined
  const bridgeText = route.kind === 'tts' ? options.bridge?.trim() : undefined
  const spoken: string[] = []
  if (aizuchiText) spoken.push(fillPrompt(promptText(locale, ALREADY_SPOKEN.aizuchi), { text: aizuchiText }))
  if (bridgeText) spoken.push(fillPrompt(promptText(locale, ALREADY_SPOKEN.bridge), { text: bridgeText }))
  else if (options.bridgePending && route.kind === 'tts') spoken.push(promptText(locale, ALREADY_SPOKEN.bridgePending))
  if (spoken.length > 0) {
    contextNotes.push(
      fillPrompt(promptText(locale, ALREADY_SPOKEN.note), { spoken: spoken.join(promptText(locale, ALREADY_SPOKEN.and)) })
    )
  }
  // What the user has open on screen, so that "this" in the utterance can point at it.
  const openApp = input.notice ? null : openAppNote(locale)
  if (openApp) contextNotes.push(openApp)
  let jobStatus: string | null = null
  const recordInput = (injection: MemoryInjection | null = null): void => {
    const sent = {
      ...(contextNotes.length ? { notes: contextNotes.join('\n\n') } : {}),
      ...(jobStatus ? { jobStatus } : {})
    }
    if (input.notice) record({ kind: 'notice', turnId, notice: input.notice, text: userText, ...sent })
    else record({ kind: 'user', turnId, text: userText, ...sent, ...(injection ? { memoryIds: injection.ids } : {}) })
  }
  // The conversation model is chosen once at the start of the turn and never changes between rounds.
  // The provider's raw output, such as a thinking signature, can only be sent back to the same model,
  // and the API rejects a tool round trip where it is missing.
  let conversationModel: ConversationModel
  let toolOptions: ToolOptions
  let system: SystemLayer[]
  let compacted = false
  let historyFull = false
  const injectionStats = { count: 0, tokens: 0, searchMs: 0 }
  let injection: MemoryInjection | null = null
  // Everything that can fail before a request is sent happens here, so that a failure ends the turn
  // before anything but the input is recorded.
  try {
    conversationModel = getSettings().conversationModel
    const providerInfo = LLM_PROVIDER_INFO[conversationModel.provider]
    if (!providerKey(conversationModel.provider)) {
      throw new Error(errorText('llmModels.errors.keyMissing', { provider: providerInfo.label, envKey: providerInfo.envKey }))
    }
    // A provider without a built-in web search must not have it listed in the tool guide either.
    toolOptions = { webSearch: providerInfo.webSearch }
    history.ensureLoaded()
    signal.throwIfAborted()
    const need = history.needsCompaction()
    // Above the limit the compaction starts before the turn, which never waits for it: a summary can
    // take minutes and can fail, and a turn waiting on it would be silent that long, again after each
    // failure. The compaction keeps the turns recent at its start and folds the older ones into the
    // summary, so this turn and any later one stay.
    if (need === 'now' || need === 'block') {
      void history.compact('limit')
      compacted = true
    }
    // Close to the API window, which replaying a long log with no checkpoint can reach, the turn is
    // not sent until the summary has shortened the history, and says so instead.
    historyFull = need === 'block'
    // The note is stored on the user record so that the memories shown to the model and the next
    // history agree. Memories already in the profile or shown in the recent history are left out.
    const memoryBlock = memory.promptBlock()
    if (!input.notice && !historyFull) {
      try {
        const searchStartedAt = Date.now()
        const hits = await waitWithAbort(memory.search(userText, { limit: 8, mode: 'utterance' }, signal), signal)
        injectionStats.searchMs = Date.now() - searchStartedAt
        injection = buildMemoryInjection(
          hits.map((hit) => hit.record),
          { locale, memoryBlock, excludeIds: history.shownMemoryIds() }
        )
        if (injection) {
          injectionStats.count = injection.count
          injectionStats.tokens = injection.tokens
          contextNotes.push(injection.text)
        }
      } catch (err) {
        // An aborted search must not be treated as "continue without injection": the input and the
        // abort are recorded and the turn closes.
        signal.throwIfAborted()
        console.error('memory injection skipped:', errMessage(err))
      }
    }
    jobStatus = jobStatusNote(locale, agentRunner.contextBlock(), history.lastJobStatus())
    // The system prompt is frozen when the turn starts: if it varied between rounds, no prompt cache
    // within the turn would ever hit.
    system = buildSystemLayers({
      locale,
      persona: getSettings().persona,
      toolGuide: toolGuide(locale, toolOptions),
      memoryBlock,
      historySummary: history.summary
    })
    signal.throwIfAborted()
  } catch (err) {
    recordInput()
    if (signal.aborted) {
      recordAssistant('', { interrupted: 'before-reply' })
    } else {
      console.error('brain preparation failed:', errMessage(err))
      recordAssistant('', { failed: true })
      emit({ type: 'error', turnId, message: errMessage(err) })
    }
    emit({ type: 'done', turnId, fullText: '' })
    return
  }
  // The conversation log is authoritative, so the record is written once the notes are settled; on an
  // early end the path above stores the input as it stands.
  recordInput(injection)
  // The request is built from this revision of the history, and what the server measures on it is
  // kept only while it still describes the history.
  const revision = history.revision
  const ctx: ToolContext = { turnId, signal, emit }
  const searchCards = new SearchCards(ctx)
  const startedAt = Date.now()
  let ttftSent = false
  let lastTextAt = Date.now()
  let visibleReply = ''
  // The usage of each round, null for a round whose usage never arrived. At the end of the turn the
  // total and the context length of the last round go into the metrics.
  const roundUsages: Array<RoundUsage | null> = []
  let toolCalls = 0
  // A stream dropped after speaking began is resumed at most once per turn.
  let resumed = false
  // Why the cache missed on the first round, compared against the previous request.
  let cacheMissReason: CacheMissReason | null = null
  const emitUsage = (): void => {
    if (roundUsages.length === 0) return
    // A round without its usage leaves the turn's token counts unknown, so none are reported and the
    // history keeps its own estimate of the context.
    const usage = roundUsages.every((round): round is RoundUsage => round !== null) ? summarizeTurnUsage(roundUsages) : null
    // The context length the server counted goes to the history, which decides the compaction thresholds from it.
    if (usage) history.noteContextTokens(usage.contextTokens ?? 0, revision)
    emit({
      type: 'metrics',
      turnId,
      timings: {
        ...usage,
        toolCalls,
        ...(resumed ? { resumed } : {}),
        ...(compacted ? { compacted } : {}),
        injectedMemories: injectionStats.count,
        injectedTokens: injectionStats.tokens,
        memorySearchMs: injectionStats.searchMs,
        ...(cacheMissReason ? { cacheMissReason } : {})
      }
    })
  }

  const synth = route.open({ turnId, signal, emit, locale })
  const assembler = new SegmentAssembler(locale)
  const pushText = (delta: string): void => {
    lastTextAt = Date.now()
    if (!ttftSent) {
      ttftSent = true
      emit({ type: 'metrics', turnId, timings: { ttftMs: Date.now() - startedAt } })
    }
    emit({ type: 'delta', turnId, text: delta })
    for (const sentence of assembler.push(delta)) synth.push(sentence)
  }

  // A filler that keeps the pause alive while a search or a tool takes long. It plays a pre-synthesized
  // aizuchi clip as is, at most once per turn. The clips are Japanese backchannels, so they play only in a
  // turn whose language has them.
  let fillerPlayed = !conversationFeatures(locale).aizuchi
  const playWorkFiller = (sourceSignal: AbortSignal): void => {
    if (fillerPlayed || sourceSignal.aborted) return
    fillerPlayed = true
    // The filler only covers a pause, so a clip bank that fails leaves the pause silent and is logged.
    randomAizuchiClip('work')
      .then((clip) => {
        if (clip?.audio && !sourceSignal.aborted) {
          emit({
            type: 'segment',
            turnId,
            segment: { turnId, index: 998, text: clip.text, audio: clip.audio, phonemes: null }
          })
        }
      })
      .catch((err) => console.error('work filler failed:', errMessage(err)))
  }

  // The messages sent to the API during the turn are written to the conversation log in the shape they
  // were sent, because the next turn sends them the same way. An assistant message with tool calls is
  // recorded together with the user message holding their results.
  const recordMessages = (...sent: ConversationMessage[]): void => {
    for (const message of sent) {
      record({ kind: 'message', turnId, role: message.role, parts: message.parts, ...(message.native ? { native: message.native } : {}) })
    }
  }

  // A tool that opens a confirmation holds the turn until its round's results are recorded. The user's
  // next words then neither close the sheet as a refusal nor cut off the operation they approve, and the
  // newer turn starts from the result. A round that has closed its signal holds nothing any more.
  let releaseHold = null as (() => void) | null
  const holdForAnswer = (roundSignal: AbortSignal): boolean => {
    if (roundSignal.aborted) return false
    releaseHold ??= hold()
    return true
  }

  // A tool that runs longer than 2.5 seconds, such as a panel fetch, gets the filler to cover the pause.
  let slowToolTimer: ReturnType<typeof setTimeout> | null = null
  const logToolResult = ({ call, execution }: ToolRoundResult): void => {
    emit({ type: 'tool', turnId, name: call.name, status: execution.isError ? 'error' : 'done' })
    // The memory ids returned by recall count as already shown, so they are not
    // injected again while they remain in the raw recent history.
    const memoryIds = memoryIdsInToolResult(call.name, execution)
    record({
      kind: 'tool',
      turnId,
      name: call.name,
      input: summarizeToolInput(call.input),
      result: summarizeToolResult(execution.content),
      resultLength: execution.resultLength,
      durationMs: execution.durationMs,
      ...(execution.isError ? { isError: true } : {}),
      ...(execution.truncated ? { truncated: true } : {}),
      ...(memoryIds.length > 0 ? { memoryIds } : {})
    })
  }
  /**
   * Tool execution for one round. A tool starts as soon as its call is complete and the results keep
   * the order of the calls; read-only tools run concurrently while writing tools run one at a time.
   */
  const newToolRound = (): ToolRoundExecutor => {
    const round = new ToolRoundExecutor({
      signal,
      locale,
      isParallel: (name) => toolRegistry(locale).find(name)?.parallel ?? false,
      execute: (call, roundSignal) => executeClientTool(call.name, call.input, {
        ...ctx,
        signal: roundSignal,
        emit: (event) => { if (!roundSignal.aborted) emit(event) }
      }, locale, () => holdForAnswer(roundSignal)),
      onStart: (call) => {
        toolCalls++
        slowToolTimer ??= setTimeout(() => playWorkFiller(round.signal), 2500)
        emit({ type: 'tool', turnId, name: call.name, status: 'start' })
      },
      onFinish: logToolResult
    })
    return round
  }

  /**
   * The stream of one round. A transient API error is retried only while nothing has been emitted
   * yet: once speech has started or a tool has begun, a retry would speak or act twice, so the caller
   * resumes from what was already confirmed instead.
   */
  let emittedThisAttempt = false
  // The stream opened last, which is where the confirmed part is taken from when it drops mid-response.
  let lastStream: ConversationStream | null = null
  const streamRound = (toolRound: ToolRoundExecutor, messages: readonly ConversationMessage[]): Promise<ConversationResult> =>
    withRetry(
      async () => {
        emittedThisAttempt = false
        const stream = streamConversation({
          model: conversationModel,
          locale,
          maxTokens: MAX_OUTPUT_TOKENS,
          system,
          tools: tools(locale),
          webSearch: toolOptions.webSearch,
          messages,
          signal: withTimeoutSignal(signal, API_ROUND_TIMEOUT_MS)
        }, 'conversation')
        lastStream = stream
        let searchActive = false
        stream.on('text', (delta) => {
          if (toolRound.signal.aborted) return
          emittedThisAttempt = true
          visibleReply += delta
          pushText(delta)
        })
        // A tool call that is complete starts running without waiting for the end of the response.
        stream.on('toolCall', (call) => {
          if (toolRound.signal.aborted) return
          emittedThisAttempt = true
          toolRound.submit({ id: call.id, name: call.name, input: call.input })
        })
        stream.on('search', (event) => {
          if (toolRound.signal.aborted) return
          if (event.phase === 'start') {
            searchActive = true
            emit({ type: 'tool', turnId, name: 'web_search', status: 'start' })
            return
          }
          if (event.phase === 'cited') {
            searchCards.cite(event.sources)
            return
          }
          searchActive = false
          emit({ type: 'tool', turnId, name: 'web_search', status: 'done', detail: event.query })
          searchCards.publish(event.query, event.sources, event.suggestions)
        })
        // When a search leaves the text silent for more than 3.5 seconds, the filler covers the pause.
        const silenceWatch = setInterval(() => {
          if (searchActive && Date.now() - lastTextAt > 3500) playWorkFiller(toolRound.signal)
        }, 1000)
        try {
          return await stream.final()
        } finally {
          clearInterval(silenceWatch)
        }
      },
      {
        delays: RETRY_DELAYS_MS,
        shouldRetry: (err) => !signal.aborted && !emittedThisAttempt && isTransientApiError(err),
        onRetry: (err, { attempt }) =>
          console.warn(
            `brain: transient API error, retry ${attempt + 1}/${RETRY_DELAYS_MS.length}:`,
            errMessage(err)
          )
      }
    )

  const closeReply = async (): Promise<void> => {
    for (const sentence of assembler.flush()) synth.push(sentence)
    await synth.drain()
    // drain() returns at once on an abort and the sentences not synthesized yet are dropped, so a
    // barge-in during it leaves the reply cut short rather than said.
    signal.throwIfAborted()
    recordAssistant(visibleReply)
    emitUsage()
    emit({ type: 'done', turnId, fullText: visibleReply })
  }

  // Once the input is recorded, every way out of the turn goes through the catch below, which closes
  // the turn in the log and in the events however it ends.
  try {
    if (historyFull) {
      // Nothing goes to the model. The sentence is the reply: the user sees and hears it as one, and
      // the history records it as said, so neither the model nor the next summary reads the request as
      // left undone.
      visibleReply = say('spoken.historyFull')
      emit({ type: 'delta', turnId, text: visibleReply })
      for (const sentence of assembler.push(visibleReply)) synth.push(sentence)
      await closeReply()
      return
    }
    const messages: ConversationMessage[] = history.toMessages()
    let completed = false
    let maxTokenContinuations = 0
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (signal.aborted) break
      const toolRound = newToolRound()
      try {
        // Only the first round fingerprints what is sent and compares it with the previous request, which gives the reason for a cache miss.
        const fingerprint = round === 0 ? fingerprintRequest({ at: Date.now(), systemLayers: system, tools: tools(locale), messages }) : null
        // The clock for the text restarts each round, so time spent running tools does not count as silence during a search.
        lastTextAt = Date.now()
        let result: ConversationResult
        try {
          result = await streamRound(toolRound, messages)
        } catch (err) {
          // The stream dropped after speech had started: the confirmed part is appended, the results
          // of the tool calls that were already complete are awaited, and the model is asked to
          // continue exactly once.
          const recorded = (lastStream as ConversationStream | null)?.snapshot() ?? null
          if (signal.aborted || resumed || !recorded || !isTransientApiError(err)) throw err
          resumed = true
          console.warn('brain: stream dropped after speaking, resuming:', errMessage(err))
          const results = await toolRound.settle()
          const resume = buildResumeMessages(recorded, results, resumeAfterDisconnectNote(locale))
          messages.push(...resume)
          recordMessages(...resume)
          continue
        }
        roundUsages.push(result.usage)
        if (fingerprint) {
          // Without the usage of the round there is no telling whether the cache was read.
          cacheMissReason = result.usage ? diagnoseCacheMiss(lastRequestFingerprint(), fingerprint, result.usage) : null
          noteRequestFingerprint(fingerprint)
        }

        if (result.stop === 'end') {
          completed = true
          messages.push(result.message)
          recordMessages(result.message)
          break
        }

        if (result.stop === 'pause') {
          // A provider-side tool ran long, so the response is appended unchanged and the same request continues.
          messages.push(result.message)
          recordMessages(result.message)
          continue
        }

        if (result.stop === 'max_tokens') {
          if (maxTokenContinuations >= 1) {
            throw new TurnStopError('spoken.replyTooLong')
          }
          maxTokenContinuations++
          // A tool call the response finished before the limit has already started, and the API refuses
          // the request for the rest while any call in it has no result.
          const continuation = buildResumeMessages(result.message, await toolRound.settle(), promptText(locale, CONTINUE_AFTER_MAX_TOKENS))
          messages.push(...continuation)
          recordMessages(...continuation)
          continue
        }

        if (result.stop === 'refusal') {
          throw new TurnStopError('spoken.cannotAnswer')
        }

        // The response with its tool calls is appended, and the results of the tools started during
        // the stream are awaited.
        messages.push(result.message)
        const results = await toolRound.settle()
        if (results.length === 0) break
        // Failures go back to the model as results marked isError, and on the round before the limit
        // the message also tells the model that the next round is the last.
        const resultsMessage = buildToolResultsMessage(results, { index: round, maxRounds: MAX_TOOL_ROUNDS, allowNote: !result.pendingServerTool, locale })
        messages.push(resultsMessage)
        recordMessages(result.message, resultsMessage)
      } finally {
        if (slowToolTimer) clearTimeout(slowToolTimer)
        slowToolTimer = null
        await toolRound.close()
        releaseHold?.()
        releaseHold = null
      }
    }

    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('Turn aborted', 'AbortError')
    }
    if (!completed) {
      throw new TurnStopError('spoken.turnStopped')
    }
    await closeReply()
  } catch (err) {
    if (signal.aborted) {
      // On a barge-in, what was spoken so far is kept with a marker. Even when nothing was spoken the
      // user's utterance stays and the marker goes on the assistant side, so that a sequence such as
      // "明日の天気" followed by "あ、明後日で" keeps its context. A system notice interrupted before
      // any reply is withdrawn by the history, because the retry of the report puts it back.
      recordAssistant(visibleReply, { interrupted: visibleReply ? 'while-speaking' : 'before-reply' })
      emit({ type: 'done', turnId, fullText: visibleReply })
    } else {
      // Only a TurnStopError, such as hitting the round limit, and a failure of the API itself end the
      // turn with a prepared sentence, which is said aloud in the language of the conversation.
      console.error('brain error:', err)
      const friendly = say(err instanceof TurnStopError ? err.key : apiErrorKey(err))
      recordAssistant(visibleReply, { failed: true })
      synth.push(friendly)
      await synth.drain()
      emitUsage()
      emit({ type: 'error', turnId, message: friendly })
      emit({ type: 'done', turnId, fullText: visibleReply || friendly })
    }
  }
}
