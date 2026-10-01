import { describe, expect, it } from 'vitest'
import { CARRIER, FRAME, RATE, VOICED_FRAME_RMS, cutAizuchi, frameRms, plain, trimAizuchi } from '../scripts/aizuchi-clips/cut.mjs'

/** Audio of voice and silence, given as [seconds, voiced] parts. */
function reading(parts: Array<[number, boolean]>): Float32Array {
  const samples: number[] = []
  for (const [seconds, voiced] of parts) {
    for (let i = 0; i < Math.round(seconds * RATE); i++) samples.push(voiced ? 0.1 * Math.sin((2 * Math.PI * 220 * i) / RATE) : 0)
  }
  return Float32Array.from(samples)
}

/** The voiced runs of some audio, with their length in seconds. */
function runs(audio: Float32Array): number[] {
  const found: number[] = []
  let length = 0
  for (const rms of frameRms(audio)) {
    if (rms >= VOICED_FRAME_RMS) length++
    else if (length > 0) {
      found.push((length * FRAME) / RATE)
      length = 0
    }
  }
  if (length > 0) found.push((length * FRAME) / RATE)
  return found
}

/**
 * A recognizer for readings of 「あ、はい。」 in front of the carrier: it hears the carrier in the long run of
 * voice, 「はい。」 in a short run after another, and 「あ、」 in a short run first.
 */
async function recognize(audio: Float32Array): Promise<string> {
  const heard = runs(audio).map((seconds, index, all) => (seconds > 1 ? CARRIER : index === 0 && all.length > 1 && all[1] <= 1 ? 'あ、' : 'はい。'))
  return heard.join('')
}

describe('cutting an aizuchi out of a reading in front of the carrier', () => {
  it('cuts at the pause before the carrier, not at a pause inside the aizuchi', async () => {
    const audio = reading([[0.1, false], [0.25, true], [0.2, false], [0.3, true], [0.3, false], [1.5, true], [0.3, false]])
    const found = await cutAizuchi(audio, 'あ、はい。', recognize)
    expect(found).toMatchObject({ heard: 'あ、はい。' })
    const { samples, end } = found as { samples: Float32Array; end: number }
    expect(runs(samples)).toHaveLength(2)
    expect(runs(audio.subarray(end))).toEqual([expect.closeTo(1.5, 1)])
  })

  it('refuses a reading in which the aizuchi runs into the carrier without a pause', async () => {
    const audio = reading([[0.1, false], [0.4, true], [1.5, true], [0.3, false]])
    await expect(cutAizuchi(audio, 'はい。', recognize)).resolves.toBeTypeOf('string')
  })

  it('refuses a reading in which what follows the only pause is not the carrier', async () => {
    const garbled = async (audio: Float32Array): Promise<string> => ((await recognize(audio)) === CARRIER ? '今日はあさがおが' : recognize(audio))
    const audio = reading([[0.1, false], [0.3, true], [0.3, false], [1.5, true], [0.3, false]])
    await expect(cutAizuchi(audio, 'はい。', garbled)).resolves.toBeTypeOf('string')
  })
})

describe('checking what the recognizer heard in an aizuchi', () => {
  it('takes a long vowel mark for the vowel it draws out, so that a drawn-out aizuchi is neither refused nor taken for a short one', () => {
    expect(plain('あー、はい。')).toBe(plain('ああ、はい。'))
    expect(plain('おー。')).toBe(plain('おお'))
    expect(plain('あー。')).not.toBe(plain('あ。'))
    expect(plain('うーん。')).not.toBe(plain('うん。'))
  })
})

describe('trimming an aizuchi read alone', () => {
  it('keeps the voice with one frame before it and a short tail, and hands that to the recognizer', async () => {
    const audio = reading([[0.3, false], [0.5, true], [0.8, false]])
    const heard: number[] = []
    const found = await trimAizuchi(audio, 'うん。', async (samples: Float32Array) => {
      heard.push(samples.length)
      return 'うん。'
    })
    if (typeof found === 'string') throw new Error(found)
    expect(found.voicedMs).toBe(500)
    expect(found.samples.length).toBe(heard[0])
    expect(found.samples.length / RATE).toBeCloseTo(0.5 + 0.02 + 0.1, 2)
  })

  it('drops a short stray sound after a long pause at the end, which is not part of the aizuchi', async () => {
    const audio = reading([[0.1, false], [0.8, true], [0.35, false], [0.08, true], [0.1, false]])
    const found = await trimAizuchi(audio, 'あー。', async () => 'あー。')
    if (typeof found === 'string') throw new Error(found)
    expect(found.voicedMs).toBe(800)
  })

  it('keeps the words after a pause inside the aizuchi', async () => {
    const audio = reading([[0.1, false], [0.2, true], [0.9, false], [0.9, true], [0.1, false]])
    const found = await trimAizuchi(audio, 'あ、失礼しました。', async () => 'あ、失礼しました。')
    if (typeof found === 'string') throw new Error(found)
    expect(found.voicedMs).toBe(2000)
  })

  it('keeps a breathy start that is quieter than the voice', async () => {
    const breath = Float32Array.from({ length: Math.round(0.1 * RATE) }, (_, i) => 0.003 * Math.sin((2 * Math.PI * 900 * i) / RATE))
    const audio = Float32Array.from([...new Float32Array(Math.round(0.2 * RATE)), ...breath, ...reading([[0.5, true], [0.3, false]])])
    const found = await trimAizuchi(audio, 'はい。', async () => 'はい。')
    if (typeof found === 'string') throw new Error(found)
    // The cut starts with the breath, 0.1 s before the first voiced frame, and one frame earlier still.
    expect(found.samples.length / RATE).toBeCloseTo(0.02 + 0.1 + 0.5 + 0.1, 2)
  })

  it('refuses a reading far longer than any natural reading of the aizuchi', async () => {
    const audio = reading([[0.1, false], [3, true], [0.1, false]])
    expect(await trimAizuchi(audio, 'うん。', async () => 'うん。')).toMatch(/not a natural length/)
  })
})
