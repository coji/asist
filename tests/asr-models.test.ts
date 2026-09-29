import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ASR_MODEL_SPECS,
  asrDownloadGb,
  asrLanguage,
  asrModelChoices,
  recommendAsrModel,
  resolveAsrModel,
  whisperLanguageName
} from '../src/shared/asr-models'
import { SETTINGS_FORMAT } from '../src/shared/settings'
import { openStoredContent } from '../src/shared/stored-format'

describe('the recommended model on a Mac', () => {
  it('recommends Qwen3-ASR 0.6B on 8 GB, where free memory matters more', () => {
    expect(recommendAsrModel('metal', 8)).toEqual({ totalMemoryGb: 8, recommendedModel: 'qwen3-asr-0.6b' })
  })

  it('recommends Qwen3-ASR 1.7B from 16 GB', () => {
    expect(recommendAsrModel('metal', 16).recommendedModel).toBe('qwen3-asr-1.7b')
    expect(recommendAsrModel('metal', 32)).toEqual({ totalMemoryGb: 32, recommendedModel: 'qwen3-asr-1.7b' })
  })
})

describe('the recommended model on a Windows GPU', () => {
  it('recommends Qwen3-ASR 0.6B on a 4 GB GPU, which 1.7B does not fit beside the desktop', () => {
    expect(recommendAsrModel('vulkan', 4)).toEqual({ totalMemoryGb: 4, recommendedModel: 'qwen3-asr-0.6b' })
  })

  it('recommends Qwen3-ASR 1.7B from 6 GB of VRAM', () => {
    expect(recommendAsrModel('vulkan', 6).recommendedModel).toBe('qwen3-asr-1.7b')
    expect(recommendAsrModel('vulkan', 8).recommendedModel).toBe('qwen3-asr-1.7b')
  })
})

describe('resolving the setting', () => {
  it('resolves auto to the recommendation and keeps a chosen model', () => {
    expect(resolveAsrModel('auto', recommendAsrModel('metal', 8))).toBe('qwen3-asr-0.6b')
    expect(resolveAsrModel('qwen3-asr-0.6b', recommendAsrModel('vulkan', 24))).toBe('qwen3-asr-0.6b')
    expect(resolveAsrModel('qwen3-asr-1.7b', recommendAsrModel('metal', 8))).toBe('qwen3-asr-1.7b')
  })

  it('lists every model to choose from, with the label of its table', () => {
    expect(asrModelChoices()).toEqual([
      { id: 'qwen3-asr-1.7b', label: ASR_MODEL_SPECS['qwen3-asr-1.7b'].label },
      { id: 'qwen3-asr-0.6b', label: ASR_MODEL_SPECS['qwen3-asr-0.6b'].label }
    ])
  })
})

describe('the download of a model', () => {
  it('is the language model and its projector together, and nothing once they are installed', () => {
    const { model, mmproj } = ASR_MODEL_SPECS['qwen3-asr-1.7b']
    expect(asrDownloadGb(ASR_MODEL_SPECS['qwen3-asr-1.7b'], false)).toBeCloseTo((model.bytes + mmproj.bytes) / 1e9, 2)
    expect(asrDownloadGb(ASR_MODEL_SPECS['qwen3-asr-1.7b'], true)).toBe(0)
  })

  it('takes the projector from the same repository and commit as the language model', () => {
    for (const spec of Object.values(ASR_MODEL_SPECS)) {
      expect([spec.mmproj.repo, spec.mmproj.revision]).toEqual([spec.model.repo, spec.model.revision])
    }
  })
})

describe('the language of a transcription request', () => {
  it('gives Qwen3-ASR the English name its own configuration lists', () => {
    expect(asrLanguage('ja-JP')).toBe('Japanese')
    expect(asrLanguage('de-DE')).toBe('German')
    expect(asrLanguage('pt-BR')).toBe('Portuguese')
    expect(asrLanguage('es-419')).toBe('Spanish')
  })

  it('gives transformers.js the English name in lower case', () => {
    expect(whisperLanguageName('ja-JP')).toBe('japanese')
    expect(whisperLanguageName('id-ID')).toBe('indonesian')
    expect(whisperLanguageName('es-ES')).toBe('spanish')
  })
})

describe('the speech recognition model of an older settings file', () => {
  const sample = (version: number) =>
    JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stored', `settings.v${version}.json`), 'utf8')) as Record<string, unknown>
  const open = (version: number, asrModel: unknown) => openStoredContent(SETTINGS_FORMAT, { ...sample(version), asrModel }).value

  it.each([
    ['auto', 'auto'],
    ['qwen3-asr-1.7b-mlx', 'qwen3-asr-1.7b'],
    ['whisper-large-v3-turbo-mlx', 'auto']
  ] as const)('upgrades %s of version 3 to %s', (stored, upgraded) => {
    expect(open(3, stored).asrModel).toBe(upgraded)
  })

  it.each([
    ['auto', 'auto'],
    ['qwen3-asr-1.7b', 'qwen3-asr-1.7b'],
    ['qwen3-asr-0.6b', 'qwen3-asr-0.6b'],
    // Whisper does not run on llama.cpp; the recommendation for the machine's memory takes its place.
    ['whisper-large-v3-turbo', 'auto']
  ] as const)('upgrades %s of version 4 to %s, with the 0.6B Qwen3-TTS version 4 always spoke with', (stored, upgraded) => {
    const opened = open(4, stored)
    expect(opened.asrModel).toBe(upgraded)
    expect(opened.qwenTtsSize).toBe('0.6b')
  })

  it('refuses a value an older version did not allow rather than guessing a model', () => {
    expect(() => open(3, 'qwen3-asr-large')).toThrow()
    expect(() => open(4, 'qwen3-asr-large')).toThrow()
    expect(() => open(4, undefined)).toThrow()
  })
})
