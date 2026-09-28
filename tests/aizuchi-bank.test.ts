import type { AizuchiClip } from '@shared/ipc'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const load = vi.fn<() => Promise<AizuchiClip[]>>()
const clip = (audio: string): AizuchiClip => ({ text: 'うん', category: 'flow', weight: 1, audio })

beforeEach(() => {
  vi.resetModules()
  load.mockReset()
  vi.stubGlobal('window', { api: { aizuchiBank: load } })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('renderer aizuchi voice changes', () => {
  it('plays no aizuchi of the previous voice while the newly selected voice is loading', async () => {
    const bank = await import('../src/renderer/src/voice/aizuchi-bank')
    load.mockResolvedValueOnce([clip('old')])
    await bank.loadAizuchiBank()
    expect(bank.pickListeningClip()?.audio).toBe('old')

    let resolve!: (clips: AizuchiClip[]) => void
    load.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const pending = bank.loadAizuchiBank()
    expect(bank.pickListeningClip()).toBeNull()
    resolve([clip('selected')])
    await pending
    expect(bank.pickListeningClip()?.audio).toBe('selected')
  })

  it.each(['success', 'error'] as const)('keeps the current voice when a late %s of an older request arrives', async (outcome) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const bank = await import('../src/renderer/src/voice/aizuchi-bank')
    let resolve!: (clips: AizuchiClip[]) => void
    let reject!: (error: Error) => void
    load.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail }))
    const old = bank.loadAizuchiBank()
    load.mockResolvedValueOnce([clip('selected')])
    await bank.loadAizuchiBank()

    if (outcome === 'success') resolve([clip('old')])
    else reject(new Error('old failure'))
    await old
    expect(bank.pickListeningClip()?.audio).toBe('selected')
  })

  it('reports a bank that fails to load and plays no aizuchi', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bank = await import('../src/renderer/src/voice/aizuchi-bank')
    const failure = new Error('no pre-rendered aizuchi clip')
    load.mockRejectedValueOnce(failure)
    await bank.loadAizuchiBank()
    expect(logged).toHaveBeenCalledWith(expect.any(String), failure)
    expect(bank.pickListeningClip()).toBeNull()
  })
})
