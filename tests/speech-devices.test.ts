import { describe, expect, it } from 'vitest'
import { parseSpeechDevices } from '@shared/speech-devices'

/** What qwen3-tts-worker --devices printed on the RTX 2080 test machine, with a warning ggml wrote before it. */
const RTX_2080 = [
  'ggml_vulkan: warning: something the driver said',
  'ASIST_JSON:{"type":"devices","devices":[{"name":"Vulkan0","description":"NVIDIA GeForce RTX 2080","kind":"gpu","memoryTotal":8589934592,"memoryFree":7516192768},{"name":"CPU","description":"Intel(R) Core(TM) i9-9900K CPU @ 3.60GHz","kind":"cpu","memoryTotal":34359738368,"memoryFree":34359738368}]}',
  ''
].join('\r\n')

describe('the device list of the speech worker', () => {
  it('reads the devices from the line of the protocol among the other output', () => {
    expect(parseSpeechDevices(RTX_2080)).toEqual([
      { name: 'Vulkan0', description: 'NVIDIA GeForce RTX 2080', kind: 'gpu', memoryTotal: 8589934592 },
      { name: 'CPU', description: 'Intel(R) Core(TM) i9-9900K CPU @ 3.60GHz', kind: 'cpu', memoryTotal: 34359738368 }
    ])
  })

  it.each([
    ['no line of the protocol', 'ggml_vulkan: no device\n'],
    ['a line that is not JSON', 'ASIST_JSON:{"type":"devices",'],
    ['another message', 'ASIST_JSON:{"type":"fatal","error":"x"}'],
    ['a device of a kind it does not know', 'ASIST_JSON:{"type":"devices","devices":[{"name":"X","description":"X","kind":"npu","memoryTotal":1}]}'],
    ['a device without its memory', 'ASIST_JSON:{"type":"devices","devices":[{"name":"X","description":"X","kind":"gpu"}]}']
  ])('reads nothing from output with %s, rather than a list that would decide the wrong GPU', (_case, output) => {
    expect(parseSpeechDevices(output)).toBeNull()
  })
})
