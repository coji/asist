import { describe, expect, it } from 'vitest'
import { mlxAsrLanguage, recommendAsrModel, resolveAsrModel, whisperLanguageName, QWEN_MIN_RECOMMENDED_MEMORY_GB } from '../src/shared/asr-models'

describe('ASR model recommendation', () => {
  it('recommends Whisper MLX on 8GB, where free memory matters more', () => {
    expect(recommendAsrModel(8)).toEqual({
      totalMemoryGb: 8,
      recommendedModel: 'whisper-large-v3-turbo-mlx'
    })
  })

  it(`recommends Qwen3-ASR with ${QWEN_MIN_RECOMMENDED_MEMORY_GB}GB or more`, () => {
    expect(recommendAsrModel(16).recommendedModel).toBe('qwen3-asr-1.7b-mlx')
    expect(recommendAsrModel(32)).toEqual({
      totalMemoryGb: 32,
      recommendedModel: 'qwen3-asr-1.7b-mlx'
    })
  })

  it('resolves only auto to the recommendation and keeps an explicit choice', () => {
    const recommendation = recommendAsrModel(32)
    expect(resolveAsrModel('auto', recommendation)).toBe('qwen3-asr-1.7b-mlx')
    expect(resolveAsrModel('whisper-large-v3-turbo-mlx', recommendation)).toBe(
      'whisper-large-v3-turbo-mlx'
    )
  })
})

describe('the language of a transcription request', () => {
  it('gives Qwen3-ASR the English name its own configuration lists', () => {
    expect(mlxAsrLanguage('qwen3-asr-1.7b-mlx', 'ja-JP')).toBe('Japanese')
    expect(mlxAsrLanguage('qwen3-asr-1.7b-mlx', 'de-DE')).toBe('German')
    expect(mlxAsrLanguage('qwen3-asr-1.7b-mlx', 'pt-BR')).toBe('Portuguese')
    expect(mlxAsrLanguage('qwen3-asr-1.7b-mlx', 'es-419')).toBe('Spanish')
  })

  it('gives Whisper the ISO 639-1 code', () => {
    expect(mlxAsrLanguage('whisper-large-v3-turbo-mlx', 'ja-JP')).toBe('ja')
    expect(mlxAsrLanguage('whisper-large-v3-turbo-mlx', 'hi-IN')).toBe('hi')
  })

  it('gives transformers.js the English name in lower case', () => {
    expect(whisperLanguageName('ja-JP')).toBe('japanese')
    expect(whisperLanguageName('id-ID')).toBe('indonesian')
    expect(whisperLanguageName('es-ES')).toBe('spanish')
  })
})
