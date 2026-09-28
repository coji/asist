import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync: mocks.execFileSync }))

import { detectNvidiaGpu } from '../src/main/services/gpu'

/** The error execFileSync throws for a child that could not start or that ended badly. */
function failure(fields: { code?: string; status?: number | null; signal?: string | null; stdout?: string }): Error {
  return Object.assign(new Error('nvidia-smi failed'), fields)
}

describe('the NVIDIA GPU check', () => {
  beforeEach(() => {
    mocks.execFileSync.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('reads the GPU nvidia-smi lists', () => {
    mocks.execFileSync.mockReturnValue('NVIDIA GeForce RTX 2080, 8192, 591.86, 7.5\r\n')
    expect(detectNvidiaGpu()).toEqual({ usable: true, name: 'NVIDIA GeForce RTX 2080', memoryGb: 8 })
  })

  it.each([
    ['nvidia-smi is not installed', failure({ code: 'ENOENT' })],
    ['nvidia-smi finds no device', failure({ status: 6, stdout: 'No devices were found\r\n' })]
  ])('finds no NVIDIA GPU when %s', (_case, error) => {
    mocks.execFileSync.mockImplementation(() => {
      throw error
    })
    expect(detectNvidiaGpu()).toEqual({ usable: false, reason: 'no-nvidia-gpu' })
  })

  it.each([
    ['the driver is not running', failure({ status: 9, stdout: "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.\r\n" })],
    ['the check times out', failure({ code: 'ETIMEDOUT', status: null, signal: 'SIGTERM' })],
    ['nvidia-smi fails in another way', failure({ status: 255 })]
  ])('reports a failed check, not a missing GPU, when %s', (_case, error) => {
    mocks.execFileSync.mockImplementation(() => {
      throw error
    })
    expect(detectNvidiaGpu()).toEqual({ usable: false, reason: 'gpu-check-failed' })
  })
})
