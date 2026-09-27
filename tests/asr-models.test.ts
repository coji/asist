import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ASR_MODELS,
  asrLanguage,
  asrModelChoices,
  asrModelSpec,
  offeredAsrModels,
  recommendAsrModel,
  resolveAsrModel,
  whisperLanguageName
} from '../src/shared/asr-models'
import type { SpeechRuntime } from '../src/shared/platform'
import { SETTINGS_FORMAT } from '../src/shared/settings'
import { openStoredContent } from '../src/shared/stored-format'

const RUNTIMES: SpeechRuntime[] = ['mlx', 'cuda']

describe('the recommended model on a Mac', () => {
  it('recommends Whisper on 8 GB, where free memory matters more', () => {
    expect(recommendAsrModel('mlx', 8)).toEqual({ totalMemoryGb: 8, recommendedModel: 'whisper-large-v3-turbo' })
  })

  it('recommends Qwen3-ASR 1.7B from 16 GB', () => {
    expect(recommendAsrModel('mlx', 16).recommendedModel).toBe('qwen3-asr-1.7b')
    expect(recommendAsrModel('mlx', 32)).toEqual({ totalMemoryGb: 32, recommendedModel: 'qwen3-asr-1.7b' })
  })
})

describe('the recommended model on an NVIDIA GPU', () => {
  it('recommends Qwen3-ASR 0.6B on a 4 GB GPU, which 1.7B does not fit', () => {
    expect(recommendAsrModel('cuda', 4)).toEqual({ totalMemoryGb: 4, recommendedModel: 'qwen3-asr-0.6b' })
  })

  it('recommends Qwen3-ASR 1.7B from 6 GB of VRAM', () => {
    expect(recommendAsrModel('cuda', 6).recommendedModel).toBe('qwen3-asr-1.7b')
    expect(recommendAsrModel('cuda', 8).recommendedModel).toBe('qwen3-asr-1.7b')
  })
})

describe('resolving the setting', () => {
  it.each(RUNTIMES)('resolves auto on %s to a model that runtime offers, whatever the memory', (runtime) => {
    for (const memoryGb of [1, 4, 6, 8, 16, 128]) {
      const model = resolveAsrModel('auto', recommendAsrModel(runtime, memoryGb))
      expect(asrModelSpec(runtime, model)).not.toBeNull()
    }
  })

  it('keeps a chosen model, even one the runtime does not offer, instead of swapping in another', () => {
    const recommendation = recommendAsrModel('cuda', 8)
    expect(resolveAsrModel('whisper-large-v3-turbo', recommendation)).toBe('whisper-large-v3-turbo')
    expect(asrModelSpec('cuda', 'whisper-large-v3-turbo')).toBeNull()
    expect(resolveAsrModel('qwen3-asr-0.6b', recommendAsrModel('mlx', 32))).toBe('qwen3-asr-0.6b')
    expect(asrModelSpec('mlx', 'qwen3-asr-0.6b')).toBeNull()
  })

  it('gives every model a runtime lists a build to run', () => {
    for (const runtime of RUNTIMES) {
      for (const model of offeredAsrModels(runtime)) expect(asrModelSpec(runtime, model)).not.toBeNull()
    }
  })
})

describe('the models to choose from', () => {
  it('lists what the runtime offers', () => {
    expect(asrModelChoices('mlx', 'auto').map((choice) => [choice.id, choice.offered])).toEqual(
      offeredAsrModels('mlx').map((model) => [model, true])
    )
  })

  it('lists a selected model the runtime does not offer as unavailable, so the choice shows what the setting holds', () => {
    const choices = asrModelChoices('cuda', 'whisper-large-v3-turbo')
    expect(choices.filter((choice) => !choice.offered).map((choice) => choice.id)).toEqual(['whisper-large-v3-turbo'])
    expect(choices.filter((choice) => choice.offered).map((choice) => choice.id)).toEqual(offeredAsrModels('cuda'))
  })
})

describe('the language of a transcription request', () => {
  it('gives Qwen3-ASR the English name its own configuration lists, on either runtime', () => {
    for (const runtime of RUNTIMES) {
      const qwen = asrModelSpec(runtime, 'qwen3-asr-1.7b')!
      expect(asrLanguage(qwen, 'ja-JP')).toBe('Japanese')
      expect(asrLanguage(qwen, 'de-DE')).toBe('German')
      expect(asrLanguage(qwen, 'pt-BR')).toBe('Portuguese')
      expect(asrLanguage(qwen, 'es-419')).toBe('Spanish')
    }
  })

  it('gives Whisper on MLX the ISO 639-1 code', () => {
    const whisper = asrModelSpec('mlx', 'whisper-large-v3-turbo')!
    expect(asrLanguage(whisper, 'ja-JP')).toBe('ja')
    expect(asrLanguage(whisper, 'hi-IN')).toBe('hi')
  })

  it('gives transformers.js the English name in lower case', () => {
    expect(whisperLanguageName('ja-JP')).toBe('japanese')
    expect(whisperLanguageName('id-ID')).toBe('indonesian')
    expect(whisperLanguageName('es-ES')).toBe('spanish')
  })
})

describe('the speech recognition model of a version 3 settings file', () => {
  const v3 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stored', 'settings.v3.json'), 'utf8')) as Record<string, unknown>
  const open = (asrModel: unknown) => openStoredContent(SETTINGS_FORMAT, { ...v3, asrModel }).value.asrModel

  // The repositories are the ones version 3 ran on a Mac for each of its values.
  it.each([
    ['auto', 'auto', 'mlx-community/Qwen3-ASR-1.7B-8bit'],
    ['qwen3-asr-1.7b-mlx', 'qwen3-asr-1.7b', 'mlx-community/Qwen3-ASR-1.7B-8bit'],
    ['whisper-large-v3-turbo-mlx', 'whisper-large-v3-turbo', 'mlx-community/whisper-large-v3-turbo-asr-fp16']
  ] as const)('upgrades %s to %s, which runs the same model on a Mac', (stored, upgraded, repository) => {
    expect(open(stored)).toBe(upgraded)
    const model = resolveAsrModel(upgraded, recommendAsrModel('mlx', 32))
    expect(asrModelSpec('mlx', model)?.id).toBe(repository)
  })

  it('refuses a value version 3 did not allow rather than guessing a model', () => {
    expect(() => open('qwen3-asr-large')).toThrow()
    expect(() => open(undefined)).toThrow()
  })

  it('reads every name of version 4 as it is', () => {
    for (const asrModel of ASR_MODELS) {
      expect(openStoredContent(SETTINGS_FORMAT, { ...v3, version: 4, asrModel }).value.asrModel).toBe(asrModel)
    }
  })
})
