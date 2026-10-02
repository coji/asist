import { describe, expect, it } from 'vitest'
import { isMeaningfulTranscript } from '@shared/asr-filter'

describe('isMeaningfulTranscript', () => {
  it('accepts ordinary speech', () => {
    expect(isMeaningfulTranscript('明日の東京の天気どう?', 'ja-JP')).toBe(true)
    expect(isMeaningfulTranscript('OK Google的なやつ', 'ja-JP')).toBe(true)
  })

  it('rejects the stock hallucinations of Whisper', () => {
    expect(isMeaningfulTranscript('ご視聴ありがとうございました', 'ja-JP')).toBe(false)
    expect(isMeaningfulTranscript('ご清聴ありがとうございました。', 'ja-JP')).toBe(false)
    expect(isMeaningfulTranscript('チャンネル登録お願いします', 'ja-JP')).toBe(false)
    expect(isMeaningfulTranscript('お疲れ様でした。', 'ja-JP')).toBe(false)
    expect(isMeaningfulTranscript('(拍手)', 'ja-JP')).toBe(false)
    expect(isMeaningfulTranscript('【音楽】', 'ja-JP')).toBe(false)
  })

  it('keeps real speech that only resembles a hallucination', () => {
    // "ありがとうございました" in the middle of a sentence does not match at the start, so it passes.
    expect(isMeaningfulTranscript('昨日はありがとうございましたと伝えて', 'ja-JP')).toBe(true)
  })

  it('rejects text that is too short, only punctuation, or the same character repeated', () => {
    expect(isMeaningfulTranscript('あ', 'ja-JP')).toBe(false)
    expect(isMeaningfulTranscript('。。。', 'ja-JP')).toBe(false)
    expect(isMeaningfulTranscript('ああああああああ', 'ja-JP')).toBe(false)
  })

  it('judges a character outside the Basic Multilingual Plane as one character', () => {
    // `𠮷` is written with two UTF-16 code units, `吉` with one.
    expect(isMeaningfulTranscript('𠮷', 'ja-JP')).toBe(isMeaningfulTranscript('吉', 'ja-JP'))
    expect(isMeaningfulTranscript('𠮷𠮷𠮷𠮷', 'ja-JP')).toBe(isMeaningfulTranscript('吉吉吉吉', 'ja-JP'))
  })

  it('applies the Japanese list of hallucinations to Japanese alone', () => {
    // The same phrase spoken in a Japanese lesson held in English has to reach the assistant.
    expect(isMeaningfulTranscript('ご視聴ありがとうございました', 'en-US')).toBe(true)
    expect(isMeaningfulTranscript('(applause)', 'en-US')).toBe(true)
  })

  it('accepts a sentence in any of the scripts the conversation can be held in', () => {
    expect(isMeaningfulTranscript('What is the weather in Tokyo tomorrow?', 'en-US')).toBe(true)
    expect(isMeaningfulTranscript('कल दिल्ली का मौसम कैसा रहेगा?', 'hi-IN')).toBe(true)
    expect(isMeaningfulTranscript('내일 서울 날씨 어때?', 'ko-KR')).toBe(true)
    expect(isMeaningfulTranscript('¿Qué tiempo hará mañana?', 'es-ES')).toBe(true)
  })

  it('rejects noise in every language by the rules that do not depend on one', () => {
    expect(isMeaningfulTranscript('...', 'en-US')).toBe(false)
    expect(isMeaningfulTranscript('aaaaaaaa', 'en-US')).toBe(false)
    expect(isMeaningfulTranscript('ㅋㅋㅋㅋ', 'ko-KR')).toBe(false)
  })
})
