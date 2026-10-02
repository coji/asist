import type { LiveEvent, TurnEvent } from '@shared/ipc'
import { isSelfEcho, PlaybackLog, stripClipEcho } from '@shared/self-echo'
import { bridgeAllowed, type AizuchiClassification } from '@shared/aizuchi-classifier'
import { conversationFeatures } from '@shared/conversation-locale'
import { isLiveEngine, liveTextInput, type VoiceEngine } from '@shared/voice-engine'
import { stopsLiveEngine } from '@shared/live-session-policy'
import { safetyNoticePending } from '@shared/settings'
import { translate } from '@/i18n'
import { voiceController } from '@/voice/VoiceController'
import { liveVoice } from '@/voice/LiveVoice'
import { speechPlayer } from '@/voice/SpeechPlayer'
import { InterjectPlaybackAcks } from '@/interject-playback'
import { TurnMetrics, type RequestInput } from '@/turn-metrics'
import { loadAizuchiBank, pickAizuchi, pickListeningClip } from '@/voice/aizuchi-bank'
import { TurnOpening, type OpeningBridge } from '@/voice/opening'
import { BridgePlanner } from '@/voice/bridge-plan'
import { AizuchiClassifierFeed } from '@/voice/aizuchi-classify'
import {
  useFeedStore,
  useLiveStore,
  usePanelStore,
  useSettingsStore,
  useStatusStore,
  useToastStore,
  useTurnStore,
  type Phase
} from '@/state/stores'
import { startStoreSync } from '@/state/store-sync'
import { reportMiniAppAnswer, startMiniAppReports, useViewStore } from '@/state/view'
import { displayError, errorMessageOf } from '@/display-error'
import { platformCapabilities } from '@/platform'

/** The conversation orchestrator, wiring the voice pipeline, brain, panels and feed. It initializes once, when App mounts. */

let initialization: Promise<void> | null = null
let aiLineId: number | null = null
let pendingRequestId: string | null = null
let activeRequestId: string | null = null
const turnMetrics = new TurnMetrics(
  (payload) => window.api.metricsLog(payload),
  (timings) => useTurnStore.getState().setTimings(timings)
)
interface OpeningPolicy {
  /**
   * The aizuchi are on and their classifier runs on the partial transcripts. Besides picking the kind of
   * aizuchi, it keeps the bridge phrase out of replies, corrections, greetings and unfinished sentences.
   */
  classify: boolean
  /**
   * The utterance being captured may open with an aizuchi: the classifier runs, and the frequency drew
   * one when the capture began. Its classification at speech end picks the clip, or none.
   *
   * The look-ahead is told this as afterAizuchi while the user speaks, and the opening at speech end can
   * still leave the aizuchi out. When a listening aizuchi played just before speech end, the note still
   * holds, because that aizuchi sounded right before the phrase. A classification too unsure to pick a
   * clip, or a category without one, leaves a phrase written for an aizuchi that does not play. The
   * look-ahead is not asked again at speech end, which would delay every bridge phrase, and the phrase is
   * not dropped, which would lose it.
   */
  aizuchi: boolean
  /** The bridge phrase may play, and the look-ahead that words it runs on the partial transcripts. */
  bridge: boolean
}
/**
 * Whether the aizuchi frequency lets an aizuchi open the utterance being captured. It is drawn once, when
 * the capture begins, because the look-ahead is told while the user still speaks whether an aizuchi goes
 * before its phrase, and the aizuchi at speech end has to be the one it was told of.
 */
let aizuchiDrawn = false
/**
 * What may sound at the opening of a turn, each part by its own switch. With the TTS engine set to none
 * neither part is played. The aizuchi are Japanese and need the classifier, which runs only once its
 * model is prepared, while the bridge phrase is spoken in every language. A part switched off is neither
 * prepared nor asked of a model.
 */
function openingPolicy(): OpeningPolicy {
  const settings = useSettingsStore.getState().settings
  if (!settings || settings.ttsEngine === 'none') return { classify: false, aizuchi: false, bridge: false }
  const classify = settings.aizuchi && conversationFeatures(settings.conversationLocale).aizuchi && classifier.running
  return { classify, aizuchi: classify && aizuchiDrawn, bridge: settings.bridgePhrase }
}
/** The configured voice engine. A live engine takes the microphone and the typed text instead of the voice pipeline and brain. */
const voiceEngine = (): VoiceEngine => useSettingsStore.getState().settings?.voiceEngine ?? 'cascade'
const liveMode = (): boolean => isLiveEngine(voiceEngine())
/**
 * The feed lines that carry a live transcript, one per turnId. The user transcript is held separately
 * because it can arrive after the reply.
 */
let liveAiLineId: number | null = null
let liveAiTurnId = -1
let liveUserLineId: number | null = null
let liveUserTurnId = -1

/** The latest assistant utterance, used as context for the look-ahead and to tell whether the user is answering a question. */
function lastAssistantText(): string {
  const lines = useFeedStore.getState().lines
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].role === 'ai' && lines[i].text) return lines[i].text
  }
  return ''
}

/** Look-ahead on a fast model while the user is still speaking, so the bridge sentence is ready before speech ends. */
const planner = new BridgePlanner({
  plan: (input) => window.api.bridgePlan(input),
  onPlan: (plan) => {
    if (plan.bridge) useTurnStore.getState().setRouterNote({ kind: 'bridge', text: plan.bridge })
  },
  onFailure: (error) => {
    console.warn('bridge plan failed:', error)
    useTurnStore.getState().setRouterNote({ kind: 'bridgeFailed' })
  }
})

/** The aizuchi classifier runs on every partial recognition; the latest result at speech end picks the aizuchi. Without the worker no aizuchi sounds. */
const classifier = new AizuchiClassifierFeed({
  classify: (input) => window.api.aizuchiClassify(input),
  running: async () => (await window.api.aizuchiClassifierStatus()).running,
  onResult: (result) => useTurnStore.getState().setRouterNote({ kind: 'aizuchi', cls: result.cls, percent: Math.round(result.prob * 100) }),
  onFailure: (error) => console.warn('aizuchi classify failed:', error)
})

/**
 * The bridge an utterance that ended with this classification may have. Where the classifier runs, it
 * keeps the bridge out of replies, corrections, greetings and unfinished sentences, and none plays
 * before it has a classification. Where it does not run, only the look-ahead's own answer can rule a
 * bridge out, since its prompt returns no line for those.
 */
function openingBridge(policy: OpeningPolicy, classification: AizuchiClassification | null, partialText: string): OpeningBridge | null {
  if (!policy.bridge) return null
  if (policy.classify && (classification === null || !bridgeAllowed(classification.cls))) return null
  return { plan: planner.finish({ text: partialText, lastAssistantText: lastAssistantText(), afterAizuchi: policy.aizuchi }), screened: policy.classify }
}

/** The opening of a turn, the aizuchi and the bridge. It sounds at speech end from VAD and is handed to the brain with the final transcript. */
const opening = new TurnOpening({
  pickAizuchi,
  play: (clip, role) => speechPlayer.playClip(clip.audio, clip.text, { role }),
  synthesizeBridge: (text) => window.api.bridgeSynthesize(text),
  bodyQueuedAfter: (time) => speechPlayer.bodyQueuedAfter(time),
  measure: (startedAt, timings) => turnMetrics.updateUtterance(startedAt, timings),
  sounding: () => speechPlayer.isPlaying,
  withdrawBridge: (queued) => speechPlayer.dropWaiting(queued)
})
const interjectPlayback = new InterjectPlaybackAcks((turnId, status) =>
  window.api.turnPlaybackAck(turnId, status)
)

/** What the speaker played and when, which tells what can have leaked back into the microphone during a capture. */
const playback = new PlaybackLog()

/** The phase once the user is no longer heard: a reply being read, a turn under way or on its way, or nothing. */
function phaseAfterCapture(): Phase {
  if (speechPlayer.readingTurn >= 0) return 'speak'
  return pendingRequestId !== null || useTurnStore.getState().activeTurnId >= 0 ? 'think' : 'idle'
}

/**
 * The turn that takes the barge-ins and the user's aizuchi counted while it sounds: the turn under
 * way, or once brain has reported it done, the one whose reply is still being read.
 */
function heardTurn(): number {
  const active = useTurnStore.getState().activeTurnId
  return active >= 0 ? active : speechPlayer.readingTurn
}

/** A speech that yields no turn: its opening plays no bridge, and its measurements go. */
function dropSpeech(startedAt: number): void {
  opening.cancel(startedAt)
  turnMetrics.dropUtterance(startedAt)
}

export function initConversation(): Promise<void> {
  if (initialization) return initialization
  const operation = initializeConversation().catch((error) => {
    if (initialization === operation) initialization = null
    throw error
  })
  initialization = operation
  return operation
}

async function initializeConversation(): Promise<void> {

  const turn = useTurnStore.getState()
  const feed = useFeedStore.getState()
  const toasts = useToastStore.getState()

  await useSettingsStore.getState().load()
  const bootStatus = await window.api.getStatus()
  useStatusStore.getState().apply(bootStatus)
  applySettings()
  voiceController.handleAsrStatus(bootStatus.asr)
  useSettingsStore.subscribe(({ settings }, { settings: before }) => {
    applySettings()
    if (settings && before && stopsLiveEngine(before, settings) &&
      (voiceController.current !== 'off' || liveVoice.current !== 'off')) {
      voiceController.disable()
      liveVoice.disable()
      toasts.push({
        kind: 'info',
        title: translate('voice.engineChanged.title'),
        body: translate('voice.engineChanged.body')
      })
    }
  })

  window.api.onAizuchiBankChanged(() => void loadAizuchiBank())
  void loadAizuchiBank()
  void classifier.check()

  // The conversation follows the status the store holds, which a read moves as well as a push, and which
  // keeps a newer read over a push that arrives after it.
  useStatusStore.subscribe(({ status }, { status: prev }) => {
    if (status === null || status === prev) return
    voiceController.handleAsrStatus(status.asr)
    if (prev && (prev.asr !== status.asr || prev.tts !== status.tts)) {
      const parts: string[] = []
      if (prev.asr !== status.asr) {
        parts.push(translate(status.asr ? 'voice.services.recognitionBack' : 'voice.services.recognitionStopped'))
      }
      if (prev.tts !== status.tts) {
        parts.push(translate(status.tts ? 'voice.services.speechBack' : 'voice.services.speechStopped'))
      }
      toasts.push({
        kind: status.asr && status.tts ? 'ok' : 'info',
        title: translate('voice.services.title'),
        body: parts.join(' · ')
      })
    }
  })
  window.api.onStatusChanged((status) => useStatusStore.getState().apply(status))

  // Coming back online, and becoming visible again after something like a sleep and wake, rebuild
  // the capture and audio context that froze and refresh the service status. A short window switch
  // must not disturb the microphone.
  let hiddenAt = 0
  const recoverAfterInterruption = (): void => {
    void useStatusStore.getState().refresh()
    speechPlayer.recover()
    void voiceController.recover()
    void liveVoice.recover()
  }
  window.addEventListener('online', recoverAfterInterruption)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
    } else if (hiddenAt > 0 && Date.now() - hiddenAt >= 10_000) {
      hiddenAt = 0
      recoverAfterInterruption()
    }
  })

  voiceController.events.on('state', (state) => {
    const t = useTurnStore.getState()
    if (state === 'off') t.setMic('off')
    else if (state === 'loading') t.setMic('loading')
    else t.setMic('on')
    if (state === 'capturing') {
      t.setPhase('listen')
      planner.reset()
      classifier.reset()
      void classifier.check()
      aizuchiDrawn = Math.random() < (useSettingsStore.getState().settings?.aizuchiRate ?? 0)
      opening.captureStarted()
    } else {
      opening.captureEnded()
    }
    // The partial transcript and the listening phase last while a capture is under way or awaits its
    // transcript, however it ends: as a turn, as echo, as nothing, or with the microphone turned off.
    if (state === 'listening' || state === 'off') {
      t.setPartial('')
      if (t.phase === 'listen') t.setPhase(phaseAfterCapture())
    }
  })

  voiceController.events.on('progress', (progress) =>
    useTurnStore.getState().setMic('loading', progress)
  )

  voiceController.events.on('partial', (text) => {
    useTurnStore.getState().setPartial(text)
    const policy = openingPolicy()
    if (policy.bridge) planner.observe({ text, lastAssistantText: lastAssistantText(), afterAizuchi: policy.aizuchi })
    if (policy.classify) classifier.observe({ prev: lastAssistantText(), text })
  })

  voiceController.events.on('bargein', () => {
    // The VoiceController drops the playback queue right after this, so interjections that never
    // played are returned to main and nothing more of the opening plays.
    interjectPlayback.interruptPending()
    opening.interrupt()
    const heard = heardTurn()
    if (heard >= 0) turnMetrics.increment(heard, 'bargeIns')
    // A request still waiting for its turn id is given up, so that finishUserTurnStart aborts the
    // turn once the id arrives instead of reading the reply the user talked over.
    if (pendingRequestId !== null) {
      turnMetrics.discardRequest(pendingRequestId)
      pendingRequestId = null
    }
    const active = useTurnStore.getState().activeTurnId
    if (active >= 0) {
      usePanelStore.getState().dismissLoadingOwnedBy(active)
      void window.api.turnAbort(active)
    }
  })

  // A "うん" or "はい" spoken during playback was taken as an aizuchi, so playback keeps going
  // instead of stopping.
  voiceController.events.on('userBackchannel', () => {
    useTurnStore.getState().setRouterNote({ kind: 'heardAsBackchannel' })
    const heard = heardTurn()
    if (heard >= 0) turnMetrics.increment(heard, 'userBackchannels')
  })

  // Listening aizuchi: a quiet "うん" or "なるほど" at a break in a long user utterance, which does
  // not stop the conversation.
  voiceController.events.on('backchannel', ({ kind }) => {
    const clip = pickListeningClip(kind)
    if (clip?.audio) speechPlayer.playClip(clip.audio, clip.text, { role: 'listening', volume: 0.4 })
  })

  // At speech end, as decided by VAD, the aizuchi sounds without waiting for the final transcript
  // and measurement of this utterance begins.
  voiceController.events.on('speechend', (end) => {
    const policy = openingPolicy()
    turnMetrics.beginUtterance(end.startedAt, end.speechEndAt, {
      vadMs: end.vadMs,
      vadMode: end.vadMode,
      ...(end.listening.length > 0 ? { listening: end.listening } : {})
    })
    // The aizuchi is chosen from the classification available now and is skipped when there is none,
    // while the bridge waits for the look-ahead in flight.
    const classification = policy.classify ? classifier.current() : null
    opening.begin({
      startedAt: end.startedAt,
      speechEndAt: end.speechEndAt,
      aizuchi: policy.aizuchi,
      classification,
      bridge: openingBridge(policy, classification, end.partialText),
      sinceListeningMs: voiceController.msSinceBackchannel
    })
  })

  voiceController.events.on('utterance', ({ text, vadMs, asrMs, startedAt, speechEndAt }) => {
    turnMetrics.updateUtterance(startedAt, { asrMs })
    // Only what sounded while this speech was captured can have come back through the microphone;
    // the capture runs on through the hangover's silence, vadMs past speechEndAt. `isSelfEcho` does
    // not judge short utterances, so that a genuine "はい" answer survives, and the echo of a short
    // clip is stripped off the ends instead. The utterance is dropped when nothing but echo is left.
    const capture = { startedAt, speechEndAt, endedAt: speechEndAt + vadMs }
    const cleaned = stripClipEcho(text, playback.clipsAtEdges(capture))
    if (!cleaned) {
      useTurnStore.getState().setRouterNote({ kind: 'droppedClipEcho' })
      dropSpeech(startedAt)
      return
    }
    if (isSelfEcho(cleaned, playback.heardDuring(capture))) {
      useTurnStore.getState().setRouterNote({ kind: 'droppedSelfEcho' })
      dropSpeech(startedAt)
      return
    }
    void startVoiceTurn(cleaned, startedAt, opening.claim(startedAt))
  })

  voiceController.events.on('speechdropped', ({ startedAt }) => dropSpeech(startedAt))

  voiceController.events.on('error', (message) =>
    toasts.push({ kind: 'error', title: translate('voice.micFailed'), body: message })
  )
  voiceController.events.on('maaiUnavailable', () =>
    toasts.push({ kind: 'info', title: translate('voice.maaiUnavailable.title'), body: translate('voice.maaiUnavailable.body') })
  )
  voiceController.events.on('maaiBehind', () =>
    toasts.push({ kind: 'info', title: translate('voice.maaiBehind.title'), body: translate('voice.maaiBehind.body') })
  )

  liveVoice.events.on('state', (state) => {
    const t = useTurnStore.getState()
    t.setMic(state)
    if (state === 'off') {
      speechPlayer.streamClear()
      t.setPartial('')
      t.setPhase('idle')
      useLiveStore.getState().reset()
    }
  })
  liveVoice.events.on('error', (message) => toasts.push({ kind: 'error', title: translate('voice.micLiveFailed'), body: message }))
  window.api.onLiveEvent((event) => handleLiveEvent(event))
  liveVoice.events.on('audio', (samples) => speechPlayer.streamPush(samples, 24_000))
  speechPlayer.events.on('streamstart', () => useTurnStore.getState().setPhase('speak'))
  speechPlayer.events.on('streamidle', () => {
    const t = useTurnStore.getState()
    if (t.phase === 'speak') t.setPhase(liveVoice.current === 'on' ? 'listen' : 'idle')
  })

  window.api.onTurnEvent((event) => handleTurnEvent(event))
  startMiniAppReports()
  await startStoreSync({ onHeldConfirmationClosed: resumeHeldTurn })
  window.api.onHotkeyMic(() => void enableMic())
  window.api.onToggleMic(() => void toggleMic())

  speechPlayer.events.on('segmentstart', ({ segment, durationMs }) => {
    interjectPlayback.markSegmentStarted(segment)
    playback.started(segment, performance.now())
    if (segment.clip) {
      // An aizuchi is measured at the moment it actually sounds.
      opening.clipStarted(segment, durationMs, performance.now())
      return
    }
    if (segment.index >= 0) {
      useTurnStore.getState().setPhase('speak')
      turnMetrics.playbackStarted(segment.turnId, segment.index)
    }
  })

  // A sentence stops reaching the microphone when its audio ends, not when the next one starts after
  // the pause between them.
  speechPlayer.events.on('segmentend', () => playback.stopped(performance.now()))

  speechPlayer.events.on('idle', ({ turnId }) => {
    playback.stopped(performance.now())
    const t = useTurnStore.getState()
    // A turn that ended while only its opening clip was sounding left the phase on think until now.
    if (t.phase === 'speak' || (t.phase === 'think' && t.activeTurnId < 0 && pendingRequestId === null)) {
      t.setPhase('idle')
    }
    // A turn whose playback has finished is closed after the events counted during playback are
    // appended to it.
    turnMetrics.playbackIdle(turnId)
  })

  feed.append({ role: 'sys', text: '', message: { key: 'conversation.start' } })
  // A page loaded again after a reload or a crash is not a launch, and starts with the microphone off.
  if (await window.api.isLaunchPage()) startMicAtLaunch()

  turn.setPhase('idle')
}

/**
 * Turns the microphone on for the configured voice engine, whether at launch, from the global
 * shortcut, from the tray or with the button. It stays off while the setup or the notice of the risks
 * covers the app, so that nothing is heard before they are answered.
 */
function enableMic(): Promise<void> {
  const settings = useSettingsStore.getState().settings
  if (!settings || settings.onboardingVersion < 1 || safetyNoticePending(settings)) return Promise.resolve()
  return liveMode() ? liveVoice.enable() : voiceController.enable()
}

/**
 * Turns the microphone on when the user chose to have it on at launch: at launch, and again once the
 * setup or the notice of the risks that held it off has been answered.
 */
export function startMicAtLaunch(): void {
  if (useSettingsStore.getState().settings?.micAutoStart) void enableMic()
}

function handleLiveEvent(event: LiveEvent): void {
  const turn = useTurnStore.getState()
  const feed = useFeedStore.getState()
  const live = useLiveStore.getState()
  switch (event.type) {
    case 'connection': {
      live.setConnection(event.state, event.detail)
      turn.setRouterNote({ kind: 'live', state: event.state, ...(event.detail ? { detail: event.detail } : {}) })
      if (event.state === 'open' && liveVoice.current === 'on') turn.setPhase('listen')
      break
    }
    case 'userTranscript': {
      // The user transcript is inserted before the reply line when the reply of the same turn
      // arrived first.
      if (liveUserLineId === null || liveUserTurnId !== event.turnId) {
        const line = { role: 'user' as const, text: event.text, turnId: event.turnId, streaming: !event.final }
        liveUserLineId = liveAiTurnId === event.turnId && liveAiLineId !== null ? feed.insertBefore(liveAiLineId, line) : feed.append(line)
        liveUserTurnId = event.turnId
      } else {
        feed.update(liveUserLineId, { text: event.text, streaming: !event.final })
      }
      if (!event.final) {
        if (!speechPlayer.isStreaming) turn.setPhase('listen')
        break
      }
      liveUserLineId = null
      liveUserTurnId = -1
      if (!speechPlayer.isStreaming) turn.setPhase('think')
      break
    }
    case 'assistantTranscript': {
      if (liveAiLineId === null || liveAiTurnId !== event.turnId) {
        liveAiLineId = feed.append({ role: 'ai', text: event.text, turnId: event.turnId, streaming: !event.final })
        liveAiTurnId = event.turnId
      } else {
        feed.update(liveAiLineId, { text: event.text, streaming: !event.final })
      }
      if (event.final) {
        liveAiLineId = null
        liveAiTurnId = -1
      }
      break
    }
    case 'interrupted': {
      // Only the queued audio is dropped, and the transcript line is kept, because the final
      // transcript arrives later with the same turn id and rewrites that line.
      speechPlayer.streamClear()
      if (liveAiLineId !== null) feed.update(liveAiLineId, { streaming: false })
      turn.setRouterNote({ kind: 'interrupted' })
      break
    }
    case 'latency':
      live.setLatency(event.responseMs > 0 ? event.responseMs : null, event.connectMs)
      break
    case 'usage':
      live.setUsage(event.usage)
      break
    case 'error':
      useToastStore.getState().push({ kind: 'error', title: translate('voice.liveFailed'), body: displayError(event.message) })
      feed.append({ role: 'sys', text: '', message: { key: 'conversation.error', values: { message: event.message } } })
      break
  }
}

function applySettings(): void {
  const s = useSettingsStore.getState().settings
  if (!s) return
  // The native helper is tried only where the OS has one; elsewhere capture starts on getUserMedia.
  const nativeMic = s.nativeMic && platformCapabilities().nativeMic
  liveVoice.nativeMicPreferred = nativeMic
  liveVoice.noiseSuppression = s.noiseSuppression
  voiceController.bargeIn = s.bargeIn
  voiceController.partialIntervalMs = s.partialIntervalMs
  voiceController.conversationLocale = s.conversationLocale
  voiceController.listeningAizuchi = s.listeningAizuchi && s.ttsEngine !== 'none'
  voiceController.holdProvider =
    s.aizuchi && conversationFeatures(s.conversationLocale).aizuchi ? () => classifier.holding() : null
  voiceController.localFallbackEnabled = s.localAsrEnabled
  voiceController.nativeMicPreferred = nativeMic
  voiceController.noiseSuppression = s.noiseSuppression
  voiceController.vapEnabled = s.vapEnabled
  voiceController.setHangover(s.hangoverMs)
}

/**
 * Lets the turn that waited for the answer to a confirmation be heard again once the answer is in. A
 * barge-in with no words after it stopped the speech that asked for the answer and dropped the turn from
 * the player, but main does not end a turn that waits for an answer on a barge-in alone, and the turn goes
 * on to say what came of it. Words on their way start a newer turn instead, and main ends the waiting
 * turn for that one.
 */
function resumeHeldTurn(): void {
  const active = useTurnStore.getState().activeTurnId
  if (active >= 0 && pendingRequestId === null) speechPlayer.beginTurn(active, true)
}

/**
 * Takes new input from the user and returns the id of its request, which the caller sends at once.
 * Main's turnStart stops the turn before it and keeps what the user said in every turn it stops, so
 * nothing waits for that turn to stop first: a barge-in or newer input during such a wait would drop
 * the words before the feed or main had them.
 */
function beginUserTurnRequest(input: RequestInput): string {
  const turn = useTurnStore.getState()
  const previousTurnId = turn.activeTurnId
  const requestId = crypto.randomUUID()

  // Events of the previous turn stop being accepted from the moment new input arrives.
  pendingRequestId = requestId
  activeRequestId = null
  turn.setActiveTurn(-1)
  if (aiLineId !== null) useFeedStore.getState().update(aiLineId, { streaming: false })
  aiLineId = null
  interjectPlayback.interruptPending()
  // The previous turn's speech stops, but the aizuchi that started at this utterance's speech end
  // keeps playing.
  speechPlayer.discardBody()
  turnMetrics.beginRequest(requestId, input)
  if (previousTurnId >= 0) {
    usePanelStore.getState().dismissLoadingOwnedBy(previousTurnId)
    turnMetrics.discard(previousTurnId)
  }
  return requestId
}

function activateTurn(
  turnId: number,
  requestId: string | null,
  preservePlayback = false
): void {
  const turn = useTurnStore.getState()
  const alreadyActive = turn.activeTurnId === turnId && activeRequestId === requestId
  turn.setActiveTurn(turnId)
  if (!alreadyActive && requestId !== null) turnMetrics.activate(turnId, requestId)
  activeRequestId = requestId
  pendingRequestId = null
  if (alreadyActive) return
  speechPlayer.beginTurn(turnId, preservePlayback)
  aiLineId = null
}

async function finishUserTurnStart(requestId: string, turnId: number): Promise<boolean> {
  // Responses to invoke can arrive out of order, so anything but the newest request stays dead.
  if (pendingRequestId !== requestId && activeRequestId !== requestId) {
    await window.api.turnAbort(turnId).catch(() => {})
    return false
  }
  activateTurn(turnId, requestId)
  return true
}

function failUserTurnStart(requestId: string, error: unknown): void {
  if (pendingRequestId !== requestId && activeRequestId !== requestId) return
  opening.withdraw()
  pendingRequestId = null
  activeRequestId = null
  turnMetrics.discardRequest(requestId)
  aiLineId = null
  const turn = useTurnStore.getState()
  turn.setActiveTurn(-1)
  turn.setPhase('idle')
  useToastStore.getState().push({ kind: 'error', title: translate('conversation.replyStartFailed'), body: displayError(error) })
  useFeedStore.getState().append({ role: 'sys', text: '', message: { key: 'conversation.error', values: { message: errorMessageOf(error) } } })
}

/**
 * A turn started from the final transcript of the utterance whose capture began at `startedAt`, which
 * the turn takes its measurements from. The opening belongs to the same utterance and is null when
 * nothing sounded.
 */
async function startVoiceTurn(
  text: string,
  startedAt: number,
  spokenOpening: { aizuchi: string | null; bridge: string | null; bridgePending: boolean } | null
): Promise<void> {
  const turn = useTurnStore.getState()
  const feed = useFeedStore.getState()
  const requestId = beginUserTurnRequest({ typed: false, utterance: startedAt })
  turn.setPartial('')
  turn.setPhase('think')
  feed.append({ role: 'user', text })

  try {
    const turnId = await window.api.turnStart(text, {
      ...(spokenOpening?.aizuchi ? { aizuchi: spokenOpening.aizuchi } : {}),
      ...(spokenOpening?.bridge ? { bridge: spokenOpening.bridge } : {}),
      ...(spokenOpening?.bridgePending ? { bridgePending: true } : {}),
      clientRequestId: requestId
    })
    await finishUserTurnStart(requestId, turnId)
  } catch (error) {
    failUserTurnStart(requestId, error)
  }
}

/**
 * Whether typed text can be sent as it is. In live mode, text over the engine's limit is refused with a
 * toast rather than cut, and the caller keeps it for the user to shorten.
 */
export function typedTextFits(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || !liveMode()) return true
  try {
    liveTextInput(trimmed)
    return true
  } catch (error) {
    useToastStore.getState().push({ kind: 'error', title: translate('conversation.sendFailed'), body: displayError(error) })
    return false
  }
}

/** A turn started from typed text, with no aizuchi and no end-to-end measurement. In live mode the text goes to main's live engine. */
export async function sendTypedMessage(text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) return
  const turn = useTurnStore.getState()
  if (liveMode()) {
    if (!typedTextFits(trimmed)) return
    useFeedStore.getState().append({ role: 'user', text: trimmed })
    turn.setPhase('think')
    try {
      await window.api.liveText(trimmed)
    } catch (error) {
      const message = displayError(error)
      turn.setPhase('idle')
      useToastStore.getState().push({ kind: 'error', title: translate('conversation.sendFailed'), body: message })
    }
    return
  }
  // The bridge of the voice utterance before this message would lead into the reply to the message.
  opening.withdraw()
  const requestId = beginUserTurnRequest({ typed: true })
  turn.setPhase('think')
  useFeedStore.getState().append({ role: 'user', text: trimmed })
  try {
    const turnId = await window.api.turnStart(trimmed, { typed: true, clientRequestId: requestId })
    await finishUserTurnStart(requestId, turnId)
  } catch (error) {
    failUserTurnStart(requestId, error)
  }
}

export function handleTurnEvent(event: TurnEvent): void {
  const turn = useTurnStore.getState()
  const feed = useFeedStore.getState()

  if (event.type === 'started') {
    if (event.origin === 'live') {
      // An exchange of the live engine. There is no renderer request to match it against, so it is
      // always accepted.
      activateTurn(event.turnId, null, true)
      return
    }
    if (event.origin === 'user') {
      // The start event from main and the invoke response can arrive in either order, so the
      // requestId matches them to the same start request.
      if (event.requestId !== pendingRequestId && event.requestId !== activeRequestId) return
      activateTurn(event.turnId, event.requestId ?? null)
      return
    }
    // An interjection such as a job completion report is accepted only while no user turn runs.
    if (turn.activeTurnId === event.turnId) return
    if (pendingRequestId !== null || turn.activeTurnId >= 0) {
      // Main can observe idle just as a user turn starts in the renderer. Dropping the started
      // event alone would leave main waiting for its three-minute timeout, so the interjection that
      // will not be played is returned right away.
      interjectPlayback.rejectStarted(event.turnId)
      return
    }
    // Idle in main means TTS synthesis finished, which is earlier than the end of playback in the
    // renderer, so a system report is queued behind the current speech and the rest of the queue.
    interjectPlayback.track(event.turnId)
    activateTurn(event.turnId, null, true)
    return
  }

  // Every event, panel and done included, is accepted only for the turnId that is active now.
  if (event.turnId !== turn.activeTurnId) return

  switch (event.type) {
    case 'delta': {
      if (aiLineId === null) {
        aiLineId = feed.append({ role: 'ai', text: '', turnId: event.turnId, streaming: true })
      }
      feed.appendToText(aiLineId, event.text)
      break
    }
    case 'segment': {
      // The line holds the reply as its deltas write it, which is what the conversation log keeps, and a
      // sentence of the reply is spoken only after its delta. A segment is speech alone: it can also be the
      // filler of a slow tool, or the sentence said in place of a failed reply, which the error line shows.
      interjectPlayback.markSegmentQueued(event.segment)
      speechPlayer.enqueue(event.segment)
      break
    }
    case 'segmentAudio':
      speechPlayer.pushSegmentAudio(event.turnId, event.index, event.samples, event.last)
      break
    case 'tool': {
      turn.setRouterNote({ kind: 'tool', name: event.name, status: event.status, ...(event.detail ? { detail: event.detail } : {}) })
      break
    }
    case 'panel': {
      usePanelStore.getState().apply(event.event, { ownerTurnId: event.turnId })
      break
    }
    case 'app': {
      const views = useViewStore.getState()
      void (event.open ? views.openApp(event.open) : views.closeApp()).finally(reportMiniAppAnswer)
      break
    }
    case 'metrics': {
      turnMetrics.update(event.turnId, event.timings)
      break
    }
    case 'done': {
      interjectPlayback.finishTurn(event.turnId)
      if (!event.fullText) opening.withdraw()
      usePanelStore.getState().dismissLoadingOwnedBy(event.turnId)
      if (aiLineId !== null) feed.update(aiLineId, { streaming: false })
      if (!speechPlayer.isPlaying && !speechPlayer.isStreaming) turn.setPhase(liveVoice.current === 'on' ? 'listen' : 'idle')
      turnMetrics.finish(event.turnId)
      turn.setActiveTurn(-1)
      activeRequestId = null
      aiLineId = null
      break
    }
    case 'error': {
      interjectPlayback.finishTurn(event.turnId)
      useToastStore.getState().push({ kind: 'error', title: translate('conversation.replyFailed'), body: displayError(event.message) })
      feed.append({ role: 'sys', text: '', message: { key: 'conversation.error', values: { message: event.message } } })
      break
    }
  }
}

/** Toggles the microphone from the UI, switching the cascade capture or the live capture according to the configured voice engine. */
export async function toggleMic(): Promise<void> {
  if (liveMode()) {
    if (liveVoice.current === 'off') await enableMic()
    else liveVoice.disable()
    return
  }
  if (voiceController.current === 'off') await enableMic()
  else voiceController.disable()
}
