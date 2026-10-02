import { shouldPushJobCard } from '@shared/job-cards'
import { calendarStatus, changeCalendar, listCalendar, requestCalendarAccess, signOutCalendar } from './services/calendar'
import { chatgptAuth, chatgptStatus } from './services/chatgpt'
import { ChatGptSignInReplaced } from './services/chatgpt-oauth'
import { events as mailEvents, getMailService, openMailGuide } from './services/mail'
import { confirmEvents, pendingConfirms, resolveConfirm } from './services/confirm'
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  IpcChannel,
  type AgentJob,
  type AppStatus,
  type PanelEvent,
  type PreparationProgress,
  type PreparationTarget,
  type ReviewedMerge,
  type SetupProgress,
  type SetupStatus,
  type TtsEngine,
  type TurnPlaybackAckStatus,
  type TurnStartOptions
} from '@shared/ipc'
import type { AsrModel } from '@shared/asr-models'
import { isLocalTtsEngine } from '@shared/tts-models'
import { bringsModelIntoUse, parseSettingsPatch } from '@shared/settings'
import { parseTurnMetricLog } from '@shared/turn-metric-log'
import { docsUrl } from '@shared/docs-links'
import { getSettings, saveSettings } from './services/settings'
import { features } from './services/conversation-locale'
import * as asr from './services/asr'
import * as tts from './services/tts'
import * as localTts from './services/local-tts'
import * as aizuchi from './services/aizuchi'
import * as bridgePlan from './services/bridge-plan'
import * as aizuchiClassifier from './services/aizuchi-classifier'
import * as brain from './services/brain'
import * as live from './services/live'
import { interject } from './services/brain/interject'
import { acknowledgePlayback } from './services/brain/job-reporting'
import * as agent from './services/agent'
import { usageDays } from './services/usage-ledger'
import { cliStatus, forgetCliSearches, locateCli, onCliSearched } from './services/agent-process/cli-locator'
import { appUpdateState, events as appUpdateEvents, readyUpdateInstall } from './services/app-update'
import { fetchPanel } from './services/panel-fetchers'
import {
  configuredModels,
  configuredApiKeyAvailable,
  credentialsOf,
  providerKey,
  llmKeyStates,
  saveProviderKey,
  validateConfiguration,
  validateProviderKey
} from './services/llm'
import { LLM_PROVIDERS, LLM_PROVIDER_INFO } from '@shared/llm-catalog'
import { LIVE_ENGINE_INFO, isLiveEngine, liveTextInput } from '@shared/voice-engine'
import { stopsLiveEngine } from '@shared/live-session-policy'
import { appendJsonl } from './services/store'
import * as watchdog from './services/watchdog'
import * as nativeMic from './services/native-mic'
import * as vap from './services/vap'
import * as memory from './services/memory'
import * as embedding from './services/embedding'
import { curateNow, curatedThrough, lastFailure, pendingJob } from './services/memory-curation'
import * as timers from './services/timers'
import { events as noteEvents, getNoteService } from './services/user-notes'
import { events as taskEvents, getTaskService } from './services/user-tasks'
import { hotkeyStatus, notifyFromRenderer, quitAfterAgentsStop, refreshHotkey, refreshTrayMenu } from './os-integration'
import { microphonePermission } from './services/microphone-permission'
import { platformCapabilities } from './services/platform'
import { completeSetup } from './services/setup-completion'
import { revealablePath } from './services/file-preview'
import { errorText } from '@shared/i18n/error-text'
import { isAppPage } from '@shared/app-page'
import { isExternalLink } from '@shared/external-link'
import { sliceCodePoints } from '@shared/text-slice'
import { reportOpenMiniApp } from './services/mini-app-view'
import { windowChrome } from './window-chrome'
import { isLaunchPage } from './page-lifetime'
import type { ConversationLocale } from '@shared/conversation-locale'
import { conversationLocale } from './services/conversation-locale'

/**
 * What the speech test says, in the language of the conversation. It is spoken, never shown, so it
 * lives here rather than in the dictionary of the interface: two short sentences that let the user
 * hear the voice, the same greeting in each language.
 */
const SPEECH_TEST_SENTENCE: Record<ConversationLocale, string> = {
  'ja-JP': 'こんにちは。音声のテストです。',
  'en-US': 'Hello. This is a speech test.',
  'fr-FR': 'Bonjour. Ceci est un test de la voix.',
  'de-DE': 'Hallo. Dies ist ein Sprachtest.',
  'hi-IN': 'नमस्ते। यह आवाज़ की जाँच है।',
  'id-ID': 'Halo. Ini tes suara.',
  'it-IT': 'Ciao. Questa è una prova della voce.',
  'ko-KR': '안녕하세요. 음성 테스트입니다.',
  'pt-BR': 'Olá. Este é um teste de voz.',
  'es-419': 'Hola. Esta es una prueba de voz.',
  'es-ES': 'Hola. Esta es una prueba de voz.'
}

const metricOccurrenceById = new Map<string, number>()
const MAX_TRACKED_METRIC_TURNS = 10_000
let configurationMutationChain: Promise<unknown> = Promise.resolve()

function withConfigurationMutation<T>(operation: () => Promise<T> | T): Promise<T> {
  const result = configurationMutationChain.then(operation, operation)
  configurationMutationChain = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

export function registerIpc(window: BrowserWindow, appPage: string): void {
  // The preload bridge is exposed to whatever page the window shows, so every handler first checks that
  // the call comes from the window's top frame showing the app's own page.
  const handle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, (event, ...args) => {
      const frame = event.senderFrame
      if (event.sender !== window.webContents || !frame || frame.parent !== null || !isAppPage(frame.url, appPage)) {
        throw new Error(errorText('app.startup.untrustedPage', { url: frame?.url ?? '' }))
      }
      return listener(event, ...args)
    })
  }
  const send = (channel: string, payload: unknown): void => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
  const reportProgress = (target: PreparationTarget) => (progress: SetupProgress): void => {
    const event: PreparationProgress = { ...progress, target }
    send(IpcChannel.SetupProgress, event)
  }
  const microphone = microphonePermission(platformCapabilities().os)
  const chrome = windowChrome(platformCapabilities().os)

  brain.events.on('event', (event) => send(IpcChannel.TurnEvent, event))
  agent.events.on('event', (event) => {
    if (agent.userJob(event.type === 'update' ? event.job.id : event.id)) send(IpcChannel.JobEvent, event)
  })
  // A job that starts, comes to wait for a merge or finishes pushes its card straight away, without waiting for an LLM call.
  const jobPhases = new Map<string, AgentJob>()
  agent.events.on('event', (event) => {
    if (event.type !== 'update') return
    const previous = jobPhases.get(event.job.id)
    jobPhases.set(event.job.id, event.job)
    if (!shouldPushJobCard(previous, event.job)) return
    send(IpcChannel.PanelEventPush, {
      op: 'create', key: `job:${event.job.id}`, type: 'agent-job', slot: 'right', props: { jobId: event.job.id }, state: 'ready'
    } satisfies PanelEvent)
  })
  timers.events.on('event', (event) => send(IpcChannel.TimerEvent, event))
  noteEvents.on('changed', (changes) => send(IpcChannel.NotesChanged, changes))
  taskEvents.on('changed', (tasks) => send(IpcChannel.TasksChanged, tasks))
  mailEvents.on('event', (event) => send(IpcChannel.MailEvent, event))
  confirmEvents.on('event', (event) => send(IpcChannel.ConfirmEvent, event))
  appUpdateEvents.on('changed', (state) => send(IpcChannel.AppUpdateChanged, state))
  aizuchi.events.on('changed', () => send(IpcChannel.AizuchiBankChanged, null))
  live.events.on('audio', (audio) => send(IpcChannel.LiveAudio, audio))
  live.events.on('event', (event) => send(IpcChannel.LiveEvent, event))
  timers.init()

  let statusReads = 0
  const computeStatus = async (): Promise<AppStatus> => {
    const sequence = ++statusReads
    const settings = getSettings()
    const [ttsUp, asrUp, apiUp] = await Promise.all([
      tts.available(),
      asr.available(),
      configuredApiKeyAvailable()
    ])
    return {
      sequence,
      llm: apiUp,
      conversationModel: settings.conversationModel,
      llmKeys: llmKeyStates(),
      chatgpt: chatgptStatus(),
      tts: ttsUp,
      ttsStarting: !ttsUp && tts.engineStarting(),
      ttsEngine: settings.ttsEngine,
      ttsLabel: tts.engineLabel(),
      asr: asrUp,
      asrInstalled: asr.installed(),
      // The conversation and the microphone wait for the status, so it does not wait for the user's shell.
      agent: cliStatus(settings.agentEngine),
      agentEngine: settings.agentEngine,
      voiceEngine: settings.voiceEngine,
      live: live.connection()
    }
  }

  // A push has no caller to fail to. The screens read the status themselves too and show why it failed,
  // as with an API key file that cannot be read, so a push that cannot compute it is only logged.
  const sendStatus = (): void => {
    computeStatus().then(
      (status) => send(IpcChannel.StatusChanged, status),
      (error: unknown) => console.error('the status could not be sent:', error)
    )
  }
  watchdog.start(sendStatus)
  onCliSearched(sendStatus)

  handle(IpcChannel.Status, computeStatus)
  handle(IpcChannel.GetSetupStatus, async (): Promise<SetupStatus> => {
    const [services, asrStatus] = await Promise.all([computeStatus(), asr.installationStatus()])
    return { services, asr: asrStatus }
  })

  // The settings ask for this when they open, which is when the user may just have installed or removed an
  // agent CLI; a search runs the user's shell, so the other reads of the status do not ask for one.
  handle(IpcChannel.RecheckAgentCli, () => {
    forgetCliSearches()
    // Its end sends the status again; a failure is reported where a job needs the CLI.
    void locateCli(getSettings().agentEngine).catch(() => {})
  })

  handle(IpcChannel.CompleteSetup, (_e, request: unknown) =>
    withConfigurationMutation(() => completeSetup(request))
  )

  handle(IpcChannel.LogsOpenFolder, async () => {
    const dir = app.getPath('logs')
    fs.mkdirSync(dir, { recursive: true })
    const error = await shell.openPath(dir)
    if (error) throw new Error(error)
  })
  handle(IpcChannel.FolderChoose, async (_e, startAt: unknown) => {
    const defaultPath = typeof startAt === 'string' && fs.existsSync(startAt) ? startAt : undefined
    const options = { defaultPath, properties: ['openDirectory' as const, 'createDirectory' as const] }
    // The dialog is a sheet of the app's window, so it cannot end up behind it.
    const result = await dialog.showOpenDialog(window, options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handle(IpcChannel.MicOpenPrivacy, () => shell.openExternal(microphone.settingsUrl))
  handle(IpcChannel.AppVersion, () => app.getVersion())
  handle(IpcChannel.GetPlatformCapabilities, () => platformCapabilities())
  handle(IpcChannel.IsLaunchPage, () => isLaunchPage())
  handle(IpcChannel.HotkeyStatus, () => hotkeyStatus())
  handle(IpcChannel.PaintWindowControls, (_e, colors: { symbol: unknown }) => {
    if (typeof colors?.symbol !== 'string') throw new Error('invalid window control colours')
    chrome.paintControls(window, { symbol: colors.symbol })
  })
  handle(IpcChannel.LicensesOpen, async () => {
    // npm run build writes the file into build/, and electron-builder copies it into the app's Resources.
    const file = app.isPackaged ? path.join(process.resourcesPath, 'THIRD_PARTY_NOTICES.txt') : path.join(app.getAppPath(), 'build', 'THIRD_PARTY_NOTICES.txt')
    const error = await shell.openPath(file)
    if (error) throw new Error(error)
  })
  handle(IpcChannel.AppUpdateState, () => appUpdateState())
  handle(IpcChannel.AppUpdateInstall, () => quitAfterAgentsStop(readyUpdateInstall()))
  handle(IpcChannel.ApiUsage, () => usageDays())

  // Starting the engine takes seconds, around five for VOICEVOX, so the status is returned only once the
  // engine answers.
  handle(IpcChannel.TtsVerify, async (): Promise<AppStatus> => {
    await tts.ensureEngine()
    const deadline = Date.now() + 20_000
    while (!(await tts.available()) && tts.engineStarting() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return computeStatus()
  })

  handle(IpcChannel.RequestMicPermission, () => microphone.request())

  handle(IpcChannel.MicNativeStart, () =>
    nativeMic.start(
      (frame) => send(IpcChannel.MicNativeFrame, frame),
      (reason) => send(IpcChannel.MicNativeStatus, { running: false, reason })
    )
  )
  handle(IpcChannel.MicNativeStop, () => nativeMic.stop())

  handle(IpcChannel.VapStart, () => {
    // Outside Japanese the end of an utterance is decided by the fixed hangover alone, so the worker
    // is never loaded.
    if (!getSettings().vapEnabled || !features().maai) return false
    return vap.ensureStarted((state) => send(IpcChannel.VapState, state))
  })
  handle(IpcChannel.VapPush, (_e, user: Float32Array, assistant: Float32Array) =>
    vap.pushAudio(new Float32Array(user), new Float32Array(assistant))
  )
  handle(IpcChannel.VapStatus, () => vap.installationStatus())
  handle(IpcChannel.VapPrepare, () =>
    vap.prepare(reportProgress('vap'))
  )
  handle(IpcChannel.VapPrepareCancel, () => vap.cancelPreparation())
  handle(IpcChannel.VapStop, () => vap.stop())

  handle(IpcChannel.EmbeddingStatus, () => memory.embeddingStatus())
  handle(IpcChannel.EmbeddingPrepare, async () => {
    const result = await embedding.prepare(reportProgress('embedding'))
    // Preparing again while the setting is already on, such as after the model or the runtime generation
    // changed, never toggles the setting, so the memories waiting for a vector are embedded here.
    if (result.ok) void memory.startEmbeddingIfEnabled().catch((err) => console.error('memory embedding:', err))
    return result
  })
  handle(IpcChannel.EmbeddingPrepareCancel, () => embedding.cancelPreparation())

  handle(IpcChannel.Transcribe, (_e, samples: Float32Array, rawRequestId: string) => {
    const requestId = typeof rawRequestId === 'string' ? rawRequestId.trim() : ''
    if (!requestId || requestId.length > 200) throw new Error('invalid transcription request id')
    return asr.transcribe(new Float32Array(samples), requestId)
  })
  handle(IpcChannel.TranscribeCancel, (_e, rawRequestId: string) => {
    const requestId = typeof rawRequestId === 'string' ? rawRequestId.trim() : ''
    if (!requestId || requestId.length > 200) return false
    return asr.cancelTranscription(requestId)
  })
  handle(IpcChannel.TranscribePartial, (_e, samples: Float32Array) =>
    asr.transcribePartial(new Float32Array(samples))
  )

  handle(IpcChannel.TurnStart, (_e, text: string, options?: TurnStartOptions) =>
    brain.startTurn(text, options)
  )
  handle(IpcChannel.TurnAbort, (_e, turnId: number) => brain.abortTurn(turnId))
  handle(IpcChannel.TurnInterject, (_e, text: string) => interject(text))
  handle(
    IpcChannel.TurnPlaybackAck,
    (_e, turnId: number, status: TurnPlaybackAckStatus) => {
      if (!Number.isSafeInteger(turnId) || turnId < 0) throw new Error('invalid playback turn id')
      if (status !== 'started' && status !== 'interrupted') {
        throw new Error('invalid playback acknowledgement')
      }
      acknowledgePlayback(turnId, status)
    }
  )

  handle(IpcChannel.LiveStart, () => live.start())
  handle(IpcChannel.LiveStop, () => live.stop())
  handle(IpcChannel.LivePush, (_e, samples: Float32Array) => {
    live.push(samples instanceof Float32Array ? samples : new Float32Array(samples))
  })
  handle(IpcChannel.LiveActivity, (_e, active: boolean) => {
    live.activity(active === true)
  })
  handle(IpcChannel.LiveText, (_e, text: unknown) => live.text(liveTextInput(text)))

  handle(IpcChannel.PanelFetch, (_e, type: string, props: Record<string, unknown>) =>
    fetchPanel(type, props)
  )

  handle(IpcChannel.TimerList, () => timers.list())
  handle(IpcChannel.TimerCancel, (_e, id: string) => timers.cancel(String(id)))

  handle(IpcChannel.AizuchiBank, () => aizuchi.getBank())
  handle(IpcChannel.BridgePlan, (_e, input: { text: unknown; lastAssistantText: unknown; afterAizuchi: unknown }) => {
    const text = typeof input?.text === 'string' ? input.text.trim() : ''
    if (!text || text.length > 500 || typeof input.afterAizuchi !== 'boolean') throw new Error('invalid bridge plan input')
    const lastAssistantText = typeof input.lastAssistantText === 'string' ? input.lastAssistantText : ''
    return bridgePlan.plan({ text, lastAssistantText, afterAizuchi: input.afterAizuchi })
  })
  handle(IpcChannel.BridgeClip, (_e, text: unknown) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 60) {
      throw new Error('invalid bridge text')
    }
    return bridgePlan.bridge(text.trim())
  })
  handle(IpcChannel.AizuchiClassify, (_e, input: { prev: unknown; text: unknown }) => {
    const text = typeof input?.text === 'string' ? input.text.trim() : ''
    if (!text || text.length > 500) throw new Error('invalid aizuchi classify input')
    const prev = typeof input.prev === 'string' ? sliceCodePoints(input.prev, -300) : ''
    return aizuchiClassifier.classify({ prev, text })
  })
  handle(IpcChannel.AizuchiClassifierStatus, () => aizuchiClassifier.status())
  handle(IpcChannel.AizuchiClassifierPrepare, () =>
    aizuchiClassifier.prepare(reportProgress('aizuchiClassifier'))
  )
  handle(IpcChannel.AizuchiClassifierPrepareCancel, () => aizuchiClassifier.cancelPreparation())

  handle(IpcChannel.MetricsLog, (_e, value: unknown) => {
    const { occurredAt, ...metrics } = parseTurnMetricLog(value)
    const now = Date.now()
    if (occurredAt > now + 60_000) throw new Error('invalid metrics occurrence timestamp')
    const knownOccurrence = metricOccurrenceById.get(metrics.id)
    if (knownOccurrence !== undefined && knownOccurrence !== occurredAt) {
      throw new Error('metrics occurrence timestamp mismatch')
    }
    metricOccurrenceById.set(metrics.id, occurredAt)
    if (metricOccurrenceById.size > MAX_TRACKED_METRIC_TURNS) {
      const oldest = metricOccurrenceById.keys().next().value
      if (oldest !== undefined) metricOccurrenceById.delete(oldest)
    }
    // `t` is when the turn happened, so a later revision of the same turn carries the same one.
    appendJsonl('metrics.jsonl', { t: occurredAt, ...metrics })
  })

  handle(IpcChannel.MemoryDocuments, () => memory.documents())
  handle(IpcChannel.MemoryDocumentRead, (_e, file: string) => memory.documentRead(String(file)))
  handle(IpcChannel.MemoryDocumentWrite, (_e, file: string, markdown: string, base: string) =>
    withConfigurationMutation(() => memory.documentWrite(String(file), String(markdown), String(base)))
  )
  handle(IpcChannel.MemoryDocumentCreate, (_e, input: unknown) => withConfigurationMutation(() => memory.documentCreate(input)))
  handle(IpcChannel.MemoryDocumentDelete, (_e, file: string) => withConfigurationMutation(() => memory.documentDelete(String(file))))
  handle(IpcChannel.MemoryOverview, () => ({
    ...memory.overview(),
    curatedThrough: curatedThrough(),
    pendingJobId: pendingJob()?.id ?? null,
    lastFailure: lastFailure()
  }))
  handle(IpcChannel.MemoryCurate, () => withConfigurationMutation(async () => curateNow()))

  handle(IpcChannel.TasksList, () => getTaskService().list())
  handle(IpcChannel.TaskCreate, (_e, input: unknown) => getTaskService().create(input))
  handle(IpcChannel.TaskUpdate, (_e, id: string, patch: unknown) => getTaskService().update(String(id), patch))
  handle(IpcChannel.TaskMove, (_e, move: unknown) => getTaskService().move(move))
  handle(IpcChannel.TaskRemove, (_e, id: string) => getTaskService().remove(String(id)))
  handle(IpcChannel.TasksClearDone, () => getTaskService().clearDone())
  handle(IpcChannel.NotesList, () => getNoteService().list())
  handle(IpcChannel.NotesSearch, async (_e, query: string) =>
    (await getNoteService().search(String(query))).map(({ markdown: _, ...summary }) => summary)
  )
  handle(IpcChannel.NoteRead, (_e, id: string) => getNoteService().read(String(id)))
  handle(IpcChannel.NoteCreate, (_e, markdown: unknown) => getNoteService().create(markdown))
  handle(IpcChannel.NoteWrite, (_e, id: string, markdown: unknown) => getNoteService().write(String(id), markdown))
  handle(IpcChannel.NoteRemove, (_e, id: string) => getNoteService().remove(String(id)))

  handle(IpcChannel.Notify, (_e, title: string, body: string) =>
    notifyFromRenderer(String(title), String(body))
  )
  handle(IpcChannel.MiniAppView, (_e, view: unknown) => reportOpenMiniApp(view))

  handle(IpcChannel.AsrPrepare, (_e, model?: AsrModel) => {
    const selected = model ?? getSettings().asrModel
    return asr.prepareModel(selected, reportProgress('asr'))
  })
  handle(IpcChannel.AsrPrepareCancel, () => asr.cancelPreparation())
  handle(IpcChannel.TtsPrepare, async () => {
    const engine = getSettings().ttsEngine
    // The screens offer the preparation only for the local engines, whose model this app downloads.
    if (!isLocalTtsEngine(engine)) throw new Error(`${engine} has no model to prepare`)
    const result = await localTts.prepare(engine, reportProgress('tts'))
    // A bank built while the model was missing holds no audio.
    if (result.ok && getSettings().ttsEngine === engine) aizuchi.rebuild()
    return result
  })
  handle(IpcChannel.TtsPrepareCancel, () => localTts.cancelPreparation())

  handle(IpcChannel.JobCancel, (_e, id: string) => agent.cancel(id))
  handle(IpcChannel.JobMerge, (_e, id: string, reviewed: ReviewedMerge) => {
    const into = reviewed.into === null ? null : String(reviewed.into)
    agent.merge(String(id), { commit: String(reviewed.commit), base: String(reviewed.base), into })
  })
  handle(IpcChannel.JobDiscard, (_e, id: string) => {
    agent.discard(String(id))
  })
  handle(IpcChannel.JobDiscardPreview, (_e, id: string) => agent.discardPreview(String(id)))
  handle(IpcChannel.JobDiff, (_e, id: string) => agent.diff(String(id)))
  handle(IpcChannel.JobList, () => agent.userJobs())
  handle(IpcChannel.JobLog, (_e, id: string) => agent.getLog(id))

  handle(IpcChannel.CalendarStatus, () => calendarStatus())
  handle(IpcChannel.CalendarRequestAccess, () => requestCalendarAccess())
  handle(IpcChannel.CalendarSignOut, () => signOutCalendar())
  handle(IpcChannel.CalendarEvents, (_e, range: unknown) => listCalendar(range))
  // An add, edit or delete from the screen takes the same path as the agent's and is saved only after the
  // in-app confirmation is approved.
  handle(IpcChannel.CalendarChange, (_e, change: unknown) => changeCalendar(change, new AbortController().signal))
  handle(IpcChannel.CalendarOpenGuide, () => shell.openExternal(docsUrl('calendar', getSettings().uiLocale)))
  handle(IpcChannel.MailStatus, () => getMailService().status())
  handle(IpcChannel.MailProbe, (_e, input: unknown) => getMailService().probe(input))
  handle(IpcChannel.MailAccountAdd, (_e, input: unknown) => withConfigurationMutation(() => getMailService().addAccount(input)))
  handle(IpcChannel.MailAccountUpdate, (_e, id: string, patch: unknown, password?: string) =>
    withConfigurationMutation(() => getMailService().updateAccount(String(id), patch, password === undefined ? undefined : String(password)))
  )
  handle(IpcChannel.MailAccountRemove, (_e, id: string) => withConfigurationMutation(() => getMailService().removeAccount(String(id))))
  handle(IpcChannel.MailList, (_e, query: unknown) => getMailService().list(query))
  handle(IpcChannel.MailThread, (_e, accountId: string, threadId: string) => getMailService().thread(String(accountId), String(threadId)))
  handle(IpcChannel.MailRead, (_e, id: string) => getMailService().read(String(id)))
  // Trashing from the screen goes through the same confirmation as the conversation does. Sending,
  // marking as read, starring and archiving are applied directly, since the press on screen is the approval.
  handle(IpcChannel.MailChange, (_e, change: unknown) => getMailService().change(change, new AbortController().signal, 'screen'))
  handle(IpcChannel.MailReplySettle, (_e, id: string, replyAll: boolean) => getMailService().replySettle(String(id), replyAll === true))
  // Pressing send under a reply whose recipients are shown is itself the approval, so no confirmation appears.
  handle(IpcChannel.MailReplySend, (_e, input: unknown) => getMailService().replySend(input, new AbortController().signal))
  handle(IpcChannel.MailSyncNow, () => getMailService().syncNow())
  handle(IpcChannel.MailOpenGuide, () => openMailGuide())
  handle(IpcChannel.MailDraftList, () => getMailService().draftList())
  handle(IpcChannel.MailDraftCreate, (_e, input: unknown) => getMailService().draftCreate(input, 'screen'))
  handle(IpcChannel.MailDraftUpdate, (_e, id: string, patch: unknown) => getMailService().draftUpdate(String(id), patch))
  handle(IpcChannel.MailDraftRemove, (_e, id: string) => {
    getMailService().draftRemove(String(id))
  })
  // Pressing send on a draft is itself the approval, so no confirmation appears.
  handle(IpcChannel.MailDraftSend, (_e, id: string, updatedAt: number) => getMailService().draftSend(String(id), new AbortController().signal, Number(updatedAt)))
  handle(IpcChannel.ConfirmPending, () => pendingConfirms())
  handle(IpcChannel.ConfirmResolve, (_e, id: string, approved: boolean) => {
    resolveConfirm(String(id), approved === true)
  })
  handle(IpcChannel.GetSettings, () => getSettings())
  handle(IpcChannel.SaveSettings, (_e, value: unknown) =>
    withConfigurationMutation(async () => {
      const before = getSettings()
      const patch = parseSettingsPatch(value)
      if (
        Object.prototype.hasOwnProperty.call(patch, 'onboardingVersion') &&
        patch.onboardingVersion !== before.onboardingVersion
      ) {
        throw new Error(errorText('settings.errors.onboardingLocked'))
      }

      const prospective = { ...before, ...patch }
      const switchesOpenAiAuth =
        prospective.openaiAuth !== before.openaiAuth && configuredModels(prospective).some((model) => model.provider === 'openai')
      if (bringsModelIntoUse(before, prospective) || switchesOpenAiAuth) {
        // The prospective values are checked against the real API first, so that saving cannot leave a
        // broken configuration behind. A missing key or ChatGPT sign-in for that provider is rejected here.
        const models = configuredModels(prospective)
        await validateConfiguration(models, credentialsOf(models, prospective.openaiAuth))
      }
      // A live engine is only checked for the provider's key, because the Live API has no way to query a
      // model. A failure to connect surfaces as a notification when the microphone is turned on.
      if (isLiveEngine(prospective.voiceEngine) && prospective.voiceEngine !== before.voiceEngine) {
        const info = LIVE_ENGINE_INFO[prospective.voiceEngine]
        if (!providerKey(info.provider)) {
          throw new Error(errorText('settings.errors.keyRequired', { target: info.label, envKey: LLM_PROVIDER_INFO[info.provider].envKey }))
        }
      }

      const after = saveSettings(patch)
      if (stopsLiveEngine(before, after)) {
        void live.stop().catch((error) => console.error('live stop failed:', error))
      }
      if (
        before.ttsEngine !== after.ttsEngine ||
        before.voicevoxSpeaker !== after.voicevoxSpeaker ||
        before.aivisSpeaker !== after.aivisSpeaker ||
        before.irodoriTtsVoice !== after.irodoriTtsVoice ||
        before.qwenTtsVoice !== after.qwenTtsVoice ||
        before.qwenTtsSize !== after.qwenTtsSize ||
        // The clips exist for Japanese only, so the language decides whether there is a bank at all.
        before.conversationLocale !== after.conversationLocale
      ) {
        watchdog.checkAfter(tts.ensureEngine().catch((error) => console.error('TTS engine failed to start:', error)))
        aizuchi.rebuild()
      }
      if (before.globalHotkey !== after.globalHotkey) refreshHotkey()
      if (before.uiLocale !== after.uiLocale) refreshTrayMenu()
      if (before.asrModel !== after.asrModel) watchdog.checkAfter(asr.switchModel(before.asrModel).catch((error) => console.error('speech recognition failed to start:', error)))
      if (before.memoryEmbeddingEnabled !== after.memoryEmbeddingEnabled) {
        if (after.memoryEmbeddingEnabled) {
          void memory.startEmbeddingIfEnabled().catch((err) => console.error('memory embedding:', err))
        } else {
          embedding.stop()
        }
      }
      // MaAI is resident until the setting is turned off or the conversation moves to a language whose
      // turn taking it was not trained on.
      if ((before.vapEnabled && !after.vapEnabled) || !features().maai) vap.stop()
      if (aizuchiClassifier.wanted(before) !== aizuchiClassifier.wanted(after)) {
        if (aizuchiClassifier.wanted(after)) void aizuchiClassifier.ensureStarted()
        else aizuchiClassifier.stop()
      }
      if (JSON.stringify(before.mail) !== JSON.stringify(after.mail)) getMailService().applySettings()
      return after
    })
  )

  handle(IpcChannel.SaveApiKey, (_e, rawProvider: unknown, rawKey: unknown): Promise<AppStatus> =>
    withConfigurationMutation(async () => {
      const provider = LLM_PROVIDERS.find((candidate) => candidate === rawProvider)
      if (!provider) throw new Error(errorText('settings.errors.unknownProvider', { provider: String(rawProvider) }))
      const key = String(rawKey).trim()
      await validateProviderKey(provider, key)
      saveProviderKey(provider, key)
      return computeStatus()
    })
  )

  // A sign-in waits for the browser for minutes, so it does not hold the configuration lock meanwhile; only
  // what it changes afterwards, the status, is read under it.
  // A sign-in the user cancelled, or that a newer one or a sign-out replaced, is no failure: the status it
  // returns tells the page that nobody signed in.
  handle(IpcChannel.ChatGptSignIn, async (): Promise<AppStatus> => {
    try {
      await chatgptAuth().signIn()
    } catch (error) {
      if (!(error instanceof ChatGptSignInReplaced)) throw error
    }
    return computeStatus()
  })

  handle(IpcChannel.ChatGptCancelSignIn, () => chatgptAuth().cancelSignIn())

  // Signing out while ChatGPT is the chosen method leaves OpenAI without a credential, which the next call
  // reports; the method is not switched to the API key behind the user's back.
  handle(IpcChannel.ChatGptSignOut, (): Promise<AppStatus> =>
    withConfigurationMutation(async () => {
      await chatgptAuth().signOut()
      return computeStatus()
    })
  )

  handle(IpcChannel.VerifySavedApiKey, async (_e, rawProvider: unknown): Promise<AppStatus> => {
    const provider = LLM_PROVIDERS.find((candidate) => candidate === rawProvider)
    if (!provider) throw new Error(errorText('settings.errors.unknownProvider', { provider: String(rawProvider) }))
    await validateProviderKey(provider, providerKey(provider) ?? '')
    return computeStatus()
  })

  handle(IpcChannel.ListSpeakers, (_e, engine?: TtsEngine) => tts.listSpeakers(engine))

  handle(IpcChannel.TtsTest, async () => {
    const text = SPEECH_TEST_SENTENCE[conversationLocale()]
    // The voice is resolved here rather than inside synthesize, whose catch turns every failure into
    // silent audio, so that an engine which cannot speak the language says so on the settings screen.
    const voice = await tts.resolveVoice()
    const result = await tts.synthesize(text, undefined, undefined, voice)
    return {
      turnId: 0,
      index: 0,
      text,
      audio: result.audio,
      phonemes: result.phonemes
    }
  })

  handle(IpcChannel.OpenExternal, (_e, url: unknown) => {
    const target = String(url)
    if (!isExternalLink(target)) throw new Error(errorText('app.links.refused', { url: target }))
    return shell.openExternal(target)
  })

  handle(IpcChannel.RevealPath, (_e, target: unknown) => {
    shell.showItemInFolder(revealablePath(String(target), agent.allowedFileRoots()))
  })
}
