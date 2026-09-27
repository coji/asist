import { describe, expect, it } from 'vitest'
import { nvidiaGpuSupport } from '@shared/nvidia-gpu'

describe('whether the NVIDIA GPU can run the local speech runtime', () => {
  it('uses the GPU of an RTX 2080 machine with its memory in GB', () => {
    expect(nvidiaGpuSupport('NVIDIA GeForce RTX 2080, 8192, 591.86, 7.5\r\n')).toEqual({
      usable: true,
      name: 'NVIDIA GeForce RTX 2080',
      memoryGb: 8
    })
  })

  it('rounds the memory nvidia-smi reports in MiB to the GB the card is sold with', () => {
    expect(nvidiaGpuSupport('NVIDIA GeForce RTX 4060, 8188, 591.86, 8.9')).toMatchObject({ usable: true, memoryGb: 8 })
  })

  it('reads a compute capability of two digits as newer than 7.5', () => {
    expect(nvidiaGpuSupport('NVIDIA GeForce RTX 5090, 32607, 591.86, 12.0')).toMatchObject({ usable: true, memoryGb: 32 })
  })

  it('takes the first GPU in the list that is new enough, which is the one the worker loads the model on', () => {
    const output = [
      'NVIDIA GeForce GTX 1080 Ti, 11264, 581.57, 6.1',
      'NVIDIA GeForce RTX 3060, 12288, 581.57, 8.6',
      'NVIDIA GeForce RTX 4090, 24564, 581.57, 8.9'
    ].join('\r\n')
    expect(nvidiaGpuSupport(output)).toEqual({ usable: true, name: 'NVIDIA GeForce RTX 3060', memoryGb: 12 })
  })

  it('reports a driver older than 580 as too old', () => {
    expect(nvidiaGpuSupport('NVIDIA GeForce RTX 2080, 8192, 572.83, 7.5')).toEqual({ usable: false, reason: 'driver-too-old' })
  })

  it('reports a GPU before Turing as too old, whatever the driver', () => {
    expect(nvidiaGpuSupport('NVIDIA GeForce GTX 1080, 8192, 581.57, 6.1')).toEqual({ usable: false, reason: 'gpu-too-old' })
    expect(nvidiaGpuSupport('NVIDIA GeForce GTX 1080, 8192, 566.36, 6.1')).toEqual({ usable: false, reason: 'gpu-too-old' })
  })

  it.each([
    ['nvidia-smi could not run', null],
    ['an empty output', ''],
    ['the message nvidia-smi prints without a driver', "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. Make sure that the latest NVIDIA driver is installed and running.\r\n"],
    ['a field nvidia-smi does not know', 'Field "compute_cap" is not a valid field to query.'],
    ['a memory it could not read', 'NVIDIA GeForce RTX 2080, [N/A], 591.86, 7.5']
  ])('finds no NVIDIA GPU in %s', (_case, output) => {
    expect(nvidiaGpuSupport(output)).toEqual({ usable: false, reason: 'no-nvidia-gpu' })
  })
})
