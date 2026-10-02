import { Behavior, FunctionResponseScheduling, GoogleGenAI, Modality, ThinkingLevel, type LiveServerMessage } from '@google/genai'
import { speechTag } from '@shared/conversation-locale'
import { errorText } from '@shared/i18n/error-text'
import { conversationLocale } from '../conversation-locale'
import { LIVE_ENGINE_INFO, type LiveThinkingLevel } from '@shared/voice-engine'
import type { GeminiConnectParams, GeminiServerMessage, GeminiSession } from './gemini-live'

const THINKING_LEVEL: Record<LiveThinkingLevel, ThinkingLevel> = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH }

/**
 * Wraps the Gemini Live SDK in the shape GeminiLiveEngine expects, so that the engine itself does not
 * depend on the SDK and tests can pass a fake session.
 *
 * Why the configuration looks like this: only an audio response is requested, since the text arrives as
 * the output transcription; functions are NON_BLOCKING; input and output transcription are on; the context
 * is compressed with a sliding window; and a resumption handle is taken in case the connection drops.
 * enableAffectiveDialog, which adapts the tone to the user's voice, is left off: tried with
 * gemini-3.8-live on 2026-09-16, setup succeeded but the connection was dropped with 1007 (invalid
 * argument) as soon as the first audio was sent, on both v1beta and v1alpha.
 */
export async function connectGemini(apiKey: string, params: GeminiConnectParams): Promise<GeminiSession> {
  const ai = new GoogleGenAI({ apiKey })
  const language = speechTag(conversationLocale())
  const thinkingLevel = LIVE_ENGINE_INFO['gemini-live'].models.find((model) => model.id === params.model)?.thinkingLevel
  const session = await ai.live.connect({
    model: params.model,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: params.systemInstruction,
      tools: [
        {
          functionDeclarations: params.functionDeclarations.map((declaration) => ({
            name: declaration.name,
            description: declaration.description,
            parametersJsonSchema: declaration.parametersJsonSchema,
            behavior: Behavior.NON_BLOCKING
          }))
        },
        { googleSearch: {} }
      ],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: params.voice } }, languageCode: language },
      // Left to auto-detect, the input language is sometimes taken as something other than the one
      // being spoken (seen on a real device on 2026-09-16), so it is pinned to one language.
      inputAudioTranscription: { languageCodes: [language] },
      outputAudioTranscription: { languageCodes: [language] },
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: params.resumptionHandle ? { handle: params.resumptionHandle } : {},
      ...(thinkingLevel ? { thinkingConfig: { thinkingLevel: THINKING_LEVEL[thinkingLevel] } } : {})
    },
    callbacks: {
      onmessage: (message: LiveServerMessage) => params.callbacks.onmessage(message as GeminiServerMessage),
      onerror: (event) => params.callbacks.onerror(new Error(event.message || errorText('voice.live.connectionError', { engine: LIVE_ENGINE_INFO['gemini-live'].label }))),
      onclose: (event) => params.callbacks.onclose(event.reason || `code ${event.code}`)
    }
  })
  const scheduling = {
    WHEN_IDLE: FunctionResponseScheduling.WHEN_IDLE,
    INTERRUPT: FunctionResponseScheduling.INTERRUPT,
    SILENT: FunctionResponseScheduling.SILENT
  } as const
  return {
    sendRealtimeInput: (input) => session.sendRealtimeInput(input),
    sendClientContent: (content) => session.sendClientContent(content),
    sendToolResponse: ({ functionResponses }) =>
      session.sendToolResponse({
        functionResponses: functionResponses.map((response) => ({ ...response, scheduling: scheduling[response.scheduling] }))
      }),
    close: () => session.close()
  }
}
