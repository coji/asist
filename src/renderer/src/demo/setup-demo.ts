import { ttsEngineLabel } from '@/ui/settings/context'
import { translate } from '@/i18n'
import type { ApiKeyState, RendererApi, SetupProgress } from '@shared/ipc'
import { LLM_PROVIDERS, type LlmProvider } from '@shared/llm-catalog'
import { voiceController } from '@/voice/VoiceController'

/**
 * The first-run setup of the demo. It starts from a Mac where nothing is prepared and advances the mock
 * state as the user works through the screens, so all three steps can be walked to the end. No key is
 * really verified, no model is really downloaded and no microphone permission is really requested.
 * - 'fresh': starts with no key, no speech recognition and no connected text-to-speech.
 * - 'key-failed': starts with a stored key that could not be verified.
 * - 'mic-denied': the microphone permission is refused.
 * - 'tts-missing': neither VOICEVOX nor AivisSpeech is installed, so verification fails.
 */
export type SetupDemoVariant = 'fresh' | 'key-failed' | 'mic-denied' | 'tts-missing'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function prepareSetupDemo(api: RendererApi, variant: SetupDemoVariant): void {
  const state = { asrReady: false, tts: false, completed: false }
  // The key state per provider. In 'key-failed' the Anthropic key is stored but has not been verified.
  const keys = Object.fromEntries(LLM_PROVIDERS.map((provider) => [provider, 'missing'])) as Record<LlmProvider, ApiKeyState>
  if (variant === 'key-failed') keys.anthropic = 'saved'
  const progressListeners = new Set<(progress: SetupProgress) => void>()
  const base = {
    getSettings: api.getSettings,
    getStatus: api.getStatus,
    getSetupStatus: api.getSetupStatus,
    saveSettings: api.saveSettings,
    completeSetup: api.completeSetup
  }
  // The demo starts on VOICEVOX, as the app's own default does. The demo Mac does not have it installed,
  // so it stays unconnected. The risks have not been acknowledged yet, as on a new Mac.
  void base.saveSettings({ ttsEngine: 'voicevox', safetyNoticeVersion: 0 })
  // The mock settings already count as onboarded, so every read is rewritten as not onboarded until the
  // wizard finishes.
  const unfinished = <T extends { onboardingVersion: number }>(settings: T): T => (state.completed ? settings : { ...settings, onboardingVersion: 0 })

  api.getSettings = async () => unfinished(await base.getSettings())
  api.completeSetup = async (request) => {
    state.completed = true
    return base.completeSetup(request)
  }
  api.getStatus = async () => ({
    ...(await base.getStatus()),
    // As in the app, the LLM counts as usable only once the key of the current conversation model's provider is verified.
    llm: keys[(await base.getSettings()).conversationModel.provider] === 'verified',
    llmKeys: keys,
    asr: state.asrReady,
    tts: state.tts,
    ttsEngine: (await base.getSettings()).ttsEngine,
    ttsLabel: ttsEngineLabel(translate, (await base.getSettings()).ttsEngine)
  })
  api.getSetupStatus = async () => {
    const setup = await base.getSetupStatus()
    return {
      ...setup,
      services: await api.getStatus(),
      asr: setup.asr && { ...setup.asr, runtimeInstalled: state.asrReady, modelInstalled: state.asrReady, downloadGb: state.asrReady ? 0 : setup.asr.downloadGb, ready: state.asrReady }
    }
  }
  api.saveApiKey = async (provider) => {
    await sleep(700)
    keys[provider] = 'verified'
    return api.getStatus()
  }
  api.onSetupProgress = (callback) => {
    progressListeners.add(callback)
    return () => progressListeners.delete(callback)
  }
  api.prepareAsrModel = async () => {
    const totalMb = 1800
    for (let pct = 0; pct <= 100; pct += 4) {
      progressListeners.forEach((listener) => listener({ status: 'downloading', pct, downloadedMb: Math.round((totalMb * pct) / 100), totalMb }))
      await sleep(120)
    }
    state.asrReady = true
    progressListeners.forEach((listener) => listener({ status: 'done', pct: 100, downloadedMb: totalMb, totalMb }))
    const asr = (await base.getSetupStatus()).asr
    if (!asr) throw new Error('この OS のデモではサーバーの音声認識を準備できません')
    return { ok: true, message: translate('settingsModels.preparation.done', { model: asr.label }) }
  }
  api.prepareTtsModel = async () => {
    const totalMb = 1974
    const message = translate('settingsModels.preparation.downloading', { model: 'Qwen3-TTS 0.6B 8-bit MLX' })
    for (let pct = 0; pct <= 100; pct += 4) {
      progressListeners.forEach((listener) => listener({ status: 'downloading', pct, downloadedMb: Math.round((totalMb * pct) / 100), totalMb, message }))
      await sleep(120)
    }
    state.tts = true
    progressListeners.forEach((listener) => listener({ status: 'done', pct: 100, downloadedMb: totalMb, totalMb }))
    return { ok: true, message: '' }
  }
  api.saveSettings = async (patch) => {
    // Choosing an engine does not connect it; only "検証する" ("verify") does.
    if (patch.ttsEngine) state.tts = patch.ttsEngine === 'system'
    // As in the app, changing the model checks that the provider's key can fetch it.
    if (patch.conversationModel) {
      if (keys[patch.conversationModel.provider] !== 'verified') throw new Error('このキーではモデルを取得できませんでした。通信の状態とキーを確かめてください。')
    }
    return unfinished(await base.saveSettings(patch))
  }
  // The optional models (the embedding model, ModernBERT, MaAI). Preparing one streams progress and then reports it as installed.
  const installed = { embedding: false, modernbert: false, maai: false }
  const fakePrepare = async (id: keyof typeof installed, totalMb: number): Promise<{ ok: boolean; message: string }> => {
    for (let pct = 0; pct <= 100; pct += 5) {
      progressListeners.forEach((listener) => listener({ status: 'downloading', pct, downloadedMb: Math.round((totalMb * pct) / 100), totalMb }))
      await sleep(90)
    }
    installed[id] = true
    progressListeners.forEach((listener) => listener({ status: 'done', pct: 100, downloadedMb: totalMb, totalMb }))
    return { ok: true, message: '' }
  }
  const baseExtras = { embeddingStatus: api.embeddingStatus, vapStatus: api.vapStatus, aizuchiClassifierStatus: api.aizuchiClassifierStatus }
  api.embeddingStatus = async () => ({ ...(await baseExtras.embeddingStatus()), runtimeInstalled: installed.embedding, modelInstalled: installed.embedding })
  api.embeddingPrepare = () => fakePrepare('embedding', 135)
  api.aizuchiClassifierStatus = async () => ({ ...(await baseExtras.aizuchiClassifierStatus()), runtimeInstalled: installed.modernbert, modelInstalled: installed.modernbert })
  api.aizuchiClassifierPrepare = () => fakePrepare('modernbert', 77)
  api.vapStatus = async () => ({ ...(await baseExtras.vapStatus()), runtimeInstalled: installed.maai, modelsInstalled: installed.maai })
  api.vapPrepare = () => fakePrepare('maai', 245)

  // Neither VOICEVOX nor AivisSpeech is actually contacted. The demo acts as though the engine were
  // installed, waits as if it were starting in the background, and then connects. In 'tts-missing' it
  // acts as though the engine were absent and fails.
  api.ttsVerify = async () => {
    await sleep(1400)
    const engine = (await base.getSettings()).ttsEngine
    state.tts = engine === 'system' || (engine !== 'none' && variant !== 'tts-missing')
    return api.getStatus()
  }

  api.requestMicPermission = async () => {
    await sleep(500)
    return variant !== 'mic-denied'
  }
  // Whisper in the browser does not go through window.api: the renderer fetches several hundred MB from
  // Hugging Face itself. The demo downloads nothing and only streams the progress.
  let localAsrCancelled = false
  voiceController.prepareLocalAsr = async (onProgress) => {
    localAsrCancelled = false
    for (let progress = 0; progress <= 100; progress += 4) {
      if (localAsrCancelled) throw new Error('ブラウザ内音声認識の準備をキャンセルしました')
      onProgress?.({ progress } as Parameters<NonNullable<typeof onProgress>>[0])
      await sleep(100)
    }
    return 'demo'
  }
  voiceController.cancelLocalAsrPreparation = () => {
    localAsrCancelled = true
  }

  // After the permission step the wizard opens the real microphone to check it. The demo hands it a
  // silent input stream instead, so the OS is never asked for permission.
  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream
  }
}
