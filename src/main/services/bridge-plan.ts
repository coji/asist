import { z } from 'zod'
import type { BridgeClip, BridgePlan } from '@shared/ipc'
import {
  CONVERSATION_LANGUAGE_NAMES,
  fillPrompt,
  promptLanguage,
  promptText,
  type ConversationLocale,
  type PromptLanguage,
  type PromptText
} from '@shared/conversation-locale'
import { sliceCodePoints } from '@shared/text-slice'
import { CLIP_SILENCE } from './aizuchi'
import { conversationLocale } from './conversation-locale'
import { quickJson } from './llm'
import { getSettings } from './settings'
import * as tts from './tts'

/**
 * The look-ahead made while the user is still speaking, and the bridge that fills the gap before the real
 * answer.
 *
 * The look-ahead hands the partial recognition text to a fast model and asks for a short line to say
 * before the real answer. Which aizuchi to play is the aizuchi classifier's decision, not this module's.
 * It is called several times before the utterance ends and the renderer uses the last result it has at
 * that point; one input is a few hundred tokens, a few times per utterance.
 *
 * The bridge is that line synthesized with TTS. The first sound of the real answer is measured at a p50 of
 * more than three seconds, so the silence after the aizuchi clip, which runs 0.5 to 1 second, is filled
 * with a line that fits what was just said. Only a Japanese conversation plays a clip before it; in
 * every other language the bridge is the first thing the user hears, and it fills the whole gap.
 */

/**
 * The cap on the line. It is a length of the prompt's own language: 20 Japanese characters take about
 * three seconds to say at a conversational pace, and eight English words take about the same, which is
 * as long as the gap before the real answer can absorb.
 */
const BRIDGE_CAP: Readonly<Record<PromptLanguage, number>> = { ja: 20, en: 8 }

/** How the cap is counted: characters where the language is written without spaces, words where it is not. */
const bridgeLength = (language: PromptLanguage, text: string): number =>
  language === 'ja' ? text.length : text.split(/\s+/).filter(Boolean).length

/**
 * The Japanese prompt tells the model that a backchannel clip has just played, because Japanese is the
 * only conversation that plays one. Elsewhere the line stands alone, so that part is left out rather
 * than translated.
 */
const PLAN_SYSTEM: PromptText = {
  ja: `あなたは音声アシスタントの聞き手として、ユーザーの話を受けて本題(答えや作業)に入る前に口にする、ごく短い一言(bridge)だけを用意する。ユーザーが話している途中の認識テキスト(末尾が欠けていることがある)と、直前のアシスタントの発話を受け取り、JSONで返す。

bridge の性格:
- 人が会話で自然に挟む受けの一言。{cap}文字以内、話し言葉。丁寧すぎず、砕けすぎず。
- 形は決めない。相手の言葉を受け取ったと伝わるなら何でもよい。例:
  - 相手の言葉を短く引き取る: 「明日の天気ですね、」「京都の、ラーメン屋さん。」
  - 要点を言い直す: 「徹夜か早起きか、ですよね。」
  - 作業に入る予告: 「ちょっと見てみますね。」「メール、確認します。」
  - 軽い反応: 「あー、それは。」「おー、通ったんですね。」「え、7分は厳しいですね。」
  - 相手の気持ちを受ける: 「それはしんどいですね。」
- 同じ人が同じ型で受け続けると機械的に聞こえるので、「〜ですね。」「〜の件ですね。」に偏らせない。語尾も変える。
- この一言の直前に短い相槌クリップ(うん・なるほど・了解です・確かに など)が鳴っている。同じ語で始めない。
- 答え・提案・質問・確認は書かない(本題は別に用意される)。
- 挨拶、短い返事(はい・うん・いいよ)、こちらの誤りの訂正、言いかけ(続きがある)には空文字。受けると不自然になるときも空文字でよい。

出力は JSON のオブジェクトで、bridge に一言を入れる。例: {"bridge":"徹夜か早起きか、ですよね。"}`,
  en: `You are the listening side of a voice assistant. Your only job is the very short line (the bridge) it says after taking in what the user said and before it gets to the substance, which is the answer or the work. You are given the recognition text of an utterance that is still going (the end can be missing) and the assistant's previous line, and you answer in JSON. Everything you write is in {language}.

What the bridge is:
- The short line a person drops into a conversation to show they took it in. At most {cap} words, spoken, neither stiff nor sloppy.
- The shape is open. Anything that shows you took their words in will do. For example:
  - pick their words up: "Tomorrow's weather, right." / "The ramen place in Kyoto."
  - say the point back: "So it's stay up or get up early."
  - announce the work: "Let me have a look." / "Checking your mail now."
  - a light reaction: "Oh, that one." / "Nice, you got in." / "Seven minutes is tight."
  - meet the feeling: "That sounds rough."
- The same shape every time sounds mechanical, so do not lean on one pattern and do not end them all alike.
- Do not write the answer, a suggestion, a question or a confirmation; the substance is prepared elsewhere.
- Answer with an empty string for a greeting, a short reply ("yes", "sure", "go ahead"), a correction of something you got wrong, or an utterance that clearly has more coming. An empty string is right whenever taking it in would sound unnatural.

Return a JSON object with the line in bridge. For example: {"bridge":"So it's stay up or get up early."}`
}

const PLAN_BRIDGE_DESCRIPTION: PromptText = {
  ja: `本題の前に挟む短い一言。{cap}文字以内。受けると不自然なら空文字`,
  en: `The short line said before the substance, at most {cap} words. An empty string when taking it in would sound unnatural.`
}

const PLAN_USER: PromptText = {
  ja: `直前のアシスタント: {last}\nユーザー(途中): {text}`,
  en: `The assistant's previous line: {last}\nThe user, still speaking: {text}`
}

const PLAN_USER_NO_LAST: PromptText = { ja: `(なし)`, en: `(none)` }

/** How much of the end of the previous line, which is what the user is answering, goes into the prompt. */
const LAST_LINE_MAX = 300

/**
 * The fast model's output. The line is cut short, because a long one overlaps the real answer. It is
 * measured without the brackets the model wraps it in, as the prompt's own examples do, since they
 * are stripped before it is spoken.
 */
const planSchema = (language: PromptLanguage): z.ZodType<BridgePlan> =>
  z.object({
    bridge: z
      .string()
      .overwrite((text) => text.replace(/^[「『"'\s]+|[」』"'\s]+$/g, ''))
      .refine((text) => bridgeLength(language, text) <= BRIDGE_CAP[language], {
        message: `bridge is longer than ${BRIDGE_CAP[language]}`
      })
  })

/**
 * The output shape handed to the model. Every property is required and additionalProperties is false, so
 * that the structured output of any provider accepts it, and no length constraint is written here because
 * planSchema checks the length.
 */
const planJsonSchema = (locale: ConversationLocale): Record<string, unknown> => ({
  type: 'object',
  properties: {
    bridge: {
      type: 'string',
      description: fillPrompt(promptText(locale, PLAN_BRIDGE_DESCRIPTION), { cap: String(BRIDGE_CAP[promptLanguage(locale)]) })
    }
  },
  required: ['bridge'],
  additionalProperties: false
})

/** Throws when the model's output does not have the expected shape. */
export function parseBridgePlan(locale: ConversationLocale, value: unknown): BridgePlan {
  return planSchema(promptLanguage(locale)).parse(value)
}

/** The wait is short, because a result that arrives after the utterance ends is of no use. */
const PLAN_TIMEOUT_MS = 4_000

export interface PlanInput {
  text: string
  lastAssistantText: string
}

export async function plan(input: PlanInput): Promise<BridgePlan> {
  const locale = conversationLocale()
  const language = promptLanguage(locale)
  const system = fillPrompt(promptText(locale, PLAN_SYSTEM), {
    cap: String(BRIDGE_CAP[language]),
    language: CONVERSATION_LANGUAGE_NAMES[locale]
  })
  const user = fillPrompt(promptText(locale, PLAN_USER), {
    last: sliceCodePoints(input.lastAssistantText, -LAST_LINE_MAX) || promptText(locale, PLAN_USER_NO_LAST),
    text: input.text
  })
  const raw = await quickJson(system, user, planJsonSchema(locale), AbortSignal.timeout(PLAN_TIMEOUT_MS))
  return parseBridgePlan(locale, raw)
}

/** Synthesizes the line with the same voice and the same silence as an aizuchi. `audio` is null when TTS is unreachable. */
export async function bridge(text: string): Promise<BridgeClip> {
  const settings = getSettings()
  if (settings.ttsEngine === 'system' || settings.ttsEngine === 'none' || !(await tts.available(settings.ttsEngine))) {
    return { text, audio: null }
  }
  const voice = await tts.resolveVoice(settings)
  const result = await tts.synthesize(text, undefined, { speedScale: 1.05, ...CLIP_SILENCE }, voice)
  return { text, audio: result.audio }
}
