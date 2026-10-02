import { describe, expect, it } from 'vitest'
import { bringsModelIntoUse, modelsInUse } from '@shared/settings'

/**
 * The models the settings put to use, which decide whose keys are needed and what a save checks against
 * the real API: the conversation model always, and the bridge phrase model only while the bridge phrase
 * is on.
 */

const settings = {
  conversationModel: { provider: 'anthropic', id: 'claude-sonnet-5' },
  bridgeModel: { provider: 'cerebras', id: 'gpt-oss-120b' },
  bridgePhrase: true
} as const

describe('the models in use', () => {
  it('leave the bridge phrase model out while the bridge phrase is off', () => {
    expect(modelsInUse({ ...settings, bridgePhrase: false }).map(({ model }) => model)).toEqual([settings.conversationModel])
    expect(modelsInUse(settings).map(({ model }) => model)).toEqual([settings.conversationModel, settings.bridgeModel])
  })
})

describe('a save that puts a model to use', () => {
  const off = { ...settings, bridgePhrase: false }

  it('is one that turns the bridge phrase on, or changes a model in use', () => {
    expect(bringsModelIntoUse(off, settings)).toBe(true)
    expect(bringsModelIntoUse(settings, { ...settings, bridgeModel: { provider: 'cerebras', id: 'llama-4' } })).toBe(true)
    expect(bringsModelIntoUse(off, { ...off, conversationModel: { provider: 'openai', id: 'gpt-5.6-luna' } })).toBe(true)
  })

  it('is not one that turns the bridge phrase off, changes the bridge phrase model while it is off, or changes nothing', () => {
    expect(bringsModelIntoUse(settings, off)).toBe(false)
    expect(bringsModelIntoUse(off, { ...off, bridgeModel: { provider: 'openai', id: 'gpt-5.6-luna' } })).toBe(false)
    expect(bringsModelIntoUse(settings, { ...settings })).toBe(false)
  })
})
