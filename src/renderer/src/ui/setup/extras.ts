import { useCallback, useEffect, useRef, useState } from 'react'
import { conversationFeatures, type ConversationFeatures, type ConversationLocale } from '@shared/conversation-locale'
import type { SpeakingMode } from './steps'
import { displayError } from '@/display-error'

/**
 * The extra preparations. The additional models that make the conversation better are prepared one
 * after another without asking the user, and they start by themselves once this screen is reached.
 * The progress channel `onSetupProgress` is a single one and does not say which preparation it
 * belongs to, so two preparations never run at the same time.
 */
export type ExtraState = 'waiting' | 'preparing' | 'ready' | 'failed' | 'skipped'
export interface ExtraModel {
  /** The id also names the group under `setup.extras.models` that holds the name and the description. */
  id: 'embedding' | 'modernbert' | 'maai'
  /** Where the model is distributed from. */
  link: string
  sizeMb: number
  state: ExtraState
  percent: number
  message?: string
}

const CATALOG: Array<Pick<ExtraModel, 'id' | 'link' | 'sizeMb'> & { voiceOnly: boolean; feature?: keyof ConversationFeatures }> = [
  {
    id: 'embedding',
    link: 'https://huggingface.co/intfloat/multilingual-e5-small',
    sizeMb: 135,
    voiceOnly: false
  },
  {
    id: 'modernbert',
    link: 'https://huggingface.co/sakasegawa/asist-aizuchi-ja',
    sizeMb: 77,
    voiceOnly: true,
    feature: 'aizuchi'
  },
  {
    id: 'maai',
    link: 'https://github.com/MaAI-Kyoto/MaAI',
    sizeMb: 245,
    voiceOnly: true,
    feature: 'maai'
  }
]

const RUNNERS: Record<ExtraModel['id'], { installed: () => Promise<boolean>; prepare: () => Promise<{ ok: boolean; message: string }>; enable: () => Promise<unknown> }> = {
  embedding: {
    installed: async () => {
      const status = await window.api.embeddingStatus()
      return status.runtimeInstalled && status.modelInstalled
    },
    prepare: () => window.api.embeddingPrepare(),
    enable: () => window.api.saveSettings({ memoryEmbeddingEnabled: true })
  },
  modernbert: {
    installed: async () => {
      const status = await window.api.aizuchiClassifierStatus()
      return status.runtimeInstalled && status.modelInstalled
    },
    prepare: () => window.api.aizuchiClassifierPrepare(),
    enable: async () => undefined
  },
  maai: {
    installed: async () => {
      const status = await window.api.vapStatus()
      return status.runtimeInstalled && status.modelsInstalled
    },
    prepare: () => window.api.vapPrepare(),
    // MaAI runs on the CPU for the whole conversation, and on a 16 GB M2 it slowed Qwen3-TTS below real
    // time so that replies stuttered (measured 2026-09-28). It is prepared here and turned on only by the user.
    enable: async () => undefined
  }
}

export interface ExtraModels {
  models: ExtraModel[]
  /** Every model has ended up either ready or skipped. */
  settled: boolean
  retry: (id: ExtraModel['id']) => void
  skip: (id: ExtraModel['id']) => void
}

/** Prepares the waiting models one at a time while it is active. */
export function useExtraModels(active: boolean, mode: SpeakingMode | null, locale: ConversationLocale): ExtraModels {
  const [models, setModels] = useState<ExtraModel[]>([])
  const running = useRef<ExtraModel['id'] | null>(null)

  // Once the way of talking and the language are known, the list of models that are needed is built again.
  useEffect(() => {
    if (!mode) return
    const features = conversationFeatures(locale)
    setModels(
      CATALOG.filter((model) => (!model.voiceOnly || mode === 'voice') && (!model.feature || features[model.feature])).map(
        ({ voiceOnly: _voiceOnly, feature: _feature, ...model }): ExtraModel => ({ ...model, state: 'waiting', percent: 0 })
      )
    )
  }, [mode, locale])

  const patch = useCallback((id: ExtraModel['id'], change: Partial<ExtraModel>): void => {
    setModels((current) => current.map((model) => (model.id === id ? { ...model, ...change } : model)))
  }, [])

  useEffect(() => {
    if (!active) return
    return window.api.onSetupProgress((progress) => {
      if (running.current && progress.status === 'downloading') patch(running.current, { percent: progress.pct })
    })
  }, [active, patch])

  useEffect(() => {
    if (!active || running.current) return
    const next = models.find((model) => model.state === 'waiting')
    if (!next) return
    const runner = RUNNERS[next.id]
    running.current = next.id
    patch(next.id, { state: 'preparing', percent: 0, message: undefined })
    void (async () => {
      try {
        if (!(await runner.installed())) {
          const result = await runner.prepare()
          if (!result.ok) {
            patch(next.id, { state: 'failed', message: result.message })
            return
          }
        }
        await runner.enable()
        patch(next.id, { state: 'ready', percent: 100 })
      } catch (err) {
        patch(next.id, { state: 'failed', message: displayError(err) })
      } finally {
        running.current = null
      }
    })()
  }, [active, models, patch])

  return {
    models,
    settled: models.length > 0 && models.every((model) => model.state === 'ready' || model.state === 'skipped'),
    retry: (id) => patch(id, { state: 'waiting', percent: 0, message: undefined }),
    skip: (id) => patch(id, { state: 'skipped' })
  }
}
