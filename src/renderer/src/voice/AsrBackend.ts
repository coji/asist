import { errorText } from '@shared/i18n/error-text'
import { whisperLanguageName } from '@shared/asr-models'
import { AsrEngine, type AsrProgress } from './AsrEngine'
import { conversationLocale } from '@/conversation-locale'
import { errorMessageOf } from '@/display-error'

/**
 * Which speech recognition transcribes the utterances: the server in main, or the in-browser Whisper
 * that the user has explicitly enabled. It chooses one when the microphone turns on, moves down to local
 * when the server stops and back up once it answers again, and hands an utterance the server failed on
 * to local, once.
 */

export interface AsrBackendHooks {
  /** The server stopped and local takes over. The in-browser Whisper is too slow for partial transcriptions. */
  onServerLost(): void
}

export class AsrBackend {
  /**
   * Setting this to true is the user's explicit consent to use the in-browser Whisper, several
   * hundred megabytes of it. By default nothing is downloaded and nothing falls back to it.
   */
  localFallbackEnabled = false
  private backend: 'server' | 'local' = 'server'
  private asr = new AsrEngine()
  /** Final transcriptions queued or running in the main process. Stopping cancels the real work over IPC too. */
  private serverRequests = new Set<string>()
  private localWorkInFlight = 0

  constructor(private readonly hooks: AsrBackendHooks) {}

  get onServer(): boolean {
    return this.backend === 'server'
  }

  /**
   * Prepares the in-browser Whisper on an explicit request, reporting its loading to the caller alone.
   * Because it may fetch the model, choose never calls it on its own while localFallbackEnabled is false.
   */
  prepareLocal(onProgress?: (info: AsrProgress) => void): Promise<string> {
    return this.asr.init(onProgress)
  }

  cancelLocalPreparation(): void {
    this.asr.reset(errorText('speechRecognition.errors.preparationCancelled'))
  }

  /**
   * Chooses the backend as the microphone turns on, and prepares local when it is chosen, reporting its
   * loading to onProgress. It resolves false when isCurrent turns false on the way, and throws when
   * neither backend can be used.
   */
  async choose(isCurrent: () => boolean, onProgress: (info: AsrProgress) => void): Promise<boolean> {
    // With local ASR explicitly enabled, the UI must not sit for 15 seconds waiting for the server.
    // Local is chosen and prepared at once, and the move up to the server is attempted after the
    // microphone has started.
    let status = await window.api.getStatus()
    if (!status.asr && !this.localFallbackEnabled && !status.asrInstalled) {
      throw new Error(errorText('speechRecognition.errors.notPrepared'))
    }
    if (!status.asr && !this.localFallbackEnabled) {
      // Only when local has not been chosen does this wait for the more accurate server to start.
      for (let i = 0; i < 10 && !status.asr; i++) {
        await new Promise((r) => setTimeout(r, 1500))
        if (!isCurrent()) return false
        status = await window.api.getStatus()
      }
    }
    if (!isCurrent()) return false
    if (!status.asr && !this.localFallbackEnabled) {
      throw new Error(errorText('speechRecognition.errors.serverUnavailable'))
    }
    this.backend = status.asr ? 'server' : 'local'
    console.log(`ASR backend: ${this.backend}`)
    if (this.backend === 'local') {
      await this.prepareLocal(onProgress)
      if (!isCurrent()) return false
    }
    return true
  }

  /** Moves up to the server if it has come up, even while local is in use. */
  async probeUpgrade(): Promise<void> {
    if (this.backend === 'server') return
    try {
      const status = await window.api.getStatus()
      if (status.asr) {
        this.handleStatus(true)
      }
    } catch {
      // Local stays in use until the next probe.
    }
  }

  /**
   * Applies what the service watchdog reports. Recovery goes straight back to the server, and a
   * stop sends the next final transcription to local, or to an explicit configuration error.
   */
  handleStatus(available: boolean): void {
    if (available) {
      if (this.backend !== 'server') console.log('ASR backend upgraded: local → server')
      this.backend = 'server'
      return
    }
    if (this.backend === 'server') {
      this.backend = 'local'
      this.hooks.onServerLost()
      console.warn('ASR server unavailable; next utterance will use configured recovery path')
    }
  }

  /** Cancels the transcriptions under way, on the server and in the browser, as the microphone turns off. */
  stop(): void {
    const serverRequests = [...this.serverRequests]
    this.serverRequests.clear()
    for (const requestId of serverRequests) {
      void window.api.transcribeCancel(requestId).catch(() => {})
    }
    if (this.backend === 'local' || this.localWorkInFlight > 0) {
      this.asr.reset(errorText('speechRecognition.errors.stoppedWithMic'))
    }
  }

  async transcribe(audio: Float32Array, isCurrent: () => boolean): Promise<string> {
    const ensureCurrent = (): void => {
      if (!isCurrent()) throw new DOMException(errorText('speechRecognition.errors.staleTranscription'), 'AbortError')
    }
    ensureCurrent()
    if (this.backend === 'local') {
      if (!this.localFallbackEnabled) {
        throw new Error(errorText('speechRecognition.errors.serverStopped'))
      }
      return this.transcribeLocalWithRetry(audio, isCurrent)
    }

    try {
      const requestId = crypto.randomUUID()
      this.serverRequests.add(requestId)
      try {
        const text = await window.api.transcribe(audio, requestId)
        ensureCurrent()
        return text
      } finally {
        this.serverRequests.delete(requestId)
      }
    } catch (serverError) {
      ensureCurrent()
      if (!this.localFallbackEnabled) {
        throw new Error(errorText('speechRecognition.errors.serverTranscribeFailed', { detail: errorMessageOf(serverError) }))
      }

      // A server that dies after accepting the utterance hands the same audio to local, once.
      this.backend = 'local'
      this.hooks.onServerLost()
      return this.transcribeLocalWithRetry(audio, isCurrent)
    }
  }

  private async transcribeLocalWithRetry(
    audio: Float32Array,
    isCurrent: () => boolean
  ): Promise<string> {
    this.localWorkInFlight++
    try {
      let firstError: unknown
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!isCurrent()) throw new DOMException(errorText('speechRecognition.errors.staleTranscription'), 'AbortError')
        try {
          await this.prepareLocal()
          if (!isCurrent()) throw new DOMException(errorText('speechRecognition.errors.staleTranscription'), 'AbortError')
          return await this.asr.transcribe(audio, whisperLanguageName(conversationLocale()))
        } catch (error) {
          if (!isCurrent()) throw error
          if (attempt === 1) {
            console.error('local ASR failed twice:', firstError, error)
            throw new Error(errorText('speechRecognition.errors.localRecoveryFailed'))
          }
          firstError = error
          this.asr.reset(errorText('speechRecognition.errors.retryingAfterFailure'))
        }
      }
      throw new Error(errorText('speechRecognition.errors.localRecoveryFailed'))
    } finally {
      this.localWorkInFlight--
    }
  }
}
