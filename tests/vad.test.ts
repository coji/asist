import { describe, expect, it } from 'vitest'
import { VadSegmenter, type VadUtterance } from '@/voice/VadSegmenter'

/** Builds one 20 ms frame, which is 320 samples at 16 kHz. */
const frame = (amplitude: number): Float32Array => new Float32Array(320).fill(amplitude)
const SILENT = 0.001
const LOUD = 0.3

interface Captured {
  utterances: VadUtterance[]
  starts: number
  /** Captures that ended without an utterance. */
  discards: number
}

function makeVad(hangoverMs = 350): { vad: VadSegmenter; got: Captured } {
  const got: Captured = { utterances: [], starts: 0, discards: 0 }
  const vad = new VadSegmenter({
    onSpeechStart: () => got.starts++,
    onSpeechEnd: (utterance) => (utterance ? got.utterances.push(utterance) : got.discards++)
  })
  vad.hangoverMs = hangoverMs
  return { vad, got }
}

const pushFrames = (vad: VadSegmenter, amplitude: number, count: number): void => {
  for (let i = 0; i < count; i++) vad.push(frame(amplitude))
}

describe('VadSegmenter', () => {
  it('ends the utterance when the hangover silence follows the speech', () => {
    const { vad, got } = makeVad()
    // Ten silent frames settle the noise floor, then 25 loud frames give 500 ms of speech.
    pushFrames(vad, SILENT, 10)
    pushFrames(vad, LOUD, 25)
    expect(got.starts).toBe(1)
    expect(got.utterances).toHaveLength(0)
    // 18 silent frames are 360 ms, which passes the 350 ms hangover.
    pushFrames(vad, SILENT, 18)
    expect(got.utterances).toHaveLength(1)
    expect(got.utterances[0].vadMs).toBeGreaterThanOrEqual(350)
  })

  it('hands over the whole utterance including the pre-roll, so the first syllable is not cut off', () => {
    const { vad, got } = makeVad()
    pushFrames(vad, SILENT, 30)
    pushFrames(vad, LOUD, 25)
    pushFrames(vad, SILENT, 18)
    const ms = (got.utterances[0].samples.length / 16000) * 1000
    // 500 ms of speech plus about 300 ms of pre-roll and about 360 ms of hangover silence.
    expect(ms).toBeGreaterThan(500 + 200)
  })

  it('does not run speech recognition for a click far shorter than a word', () => {
    const { vad, got } = makeVad()
    pushFrames(vad, SILENT, 10)
    // 60 ms, standing for a key press.
    pushFrames(vad, LOUD, 3)
    pushFrames(vad, SILENT, 20)
    // The start is detected, but the utterance is never confirmed, and the capture still ends.
    expect(got.starts).toBe(1)
    expect(got.utterances).toHaveLength(0)
    expect(got.discards).toBe(1)
  })

  it('ends a capture in progress with no utterance when it is muted', () => {
    const { vad, got } = makeVad()
    pushFrames(vad, SILENT, 10)
    pushFrames(vad, LOUD, 25)
    vad.muted = true
    pushFrames(vad, LOUD, 25)
    expect(got.starts).toBe(1)
    expect(got.discards).toBe(1)
    expect(vad.isSpeaking).toBe(false)
    // After unmuting, the next voice opens a new capture.
    vad.muted = false
    pushFrames(vad, LOUD, 25)
    pushFrames(vad, SILENT, 18)
    expect(got.starts).toBe(2)
    expect(got.utterances).toHaveLength(1)
  })

  it('does not split at a pause shorter than the hangover', () => {
    const { vad, got } = makeVad()
    pushFrames(vad, SILENT, 10)
    pushFrames(vad, LOUD, 15)
    // 200 ms of silence stays under the 350 ms hangover.
    pushFrames(vad, SILENT, 10)
    pushFrames(vad, LOUD, 15)
    pushFrames(vad, SILENT, 18)
    // The two halves are joined into a single utterance.
    expect(got.utterances).toHaveLength(1)
  })

  it('ignores frames while it is muted', () => {
    const { vad, got } = makeVad()
    vad.muted = true
    pushFrames(vad, LOUD, 50)
    expect(got.starts).toBe(0)
  })

  it('returns a snapshot only during speech and limits it to the last maxMs', () => {
    const { vad } = makeVad()
    expect(vad.snapshot()).toBeNull()
    pushFrames(vad, SILENT, 10)
    // 60 frames are 1.2 s of speech.
    pushFrames(vad, LOUD, 60)
    const tail = vad.snapshot(500)
    expect(tail).not.toBeNull()
    expect(tail!.length).toBeLessThanOrEqual(16000 * 0.5)
  })

  it('adds only voiced time to voicedDuration and resets it at the end, which is what a barge-in is judged on', () => {
    const { vad } = makeVad()
    pushFrames(vad, SILENT, 10)
    // Ten loud frames are 200 ms of voiced audio.
    pushFrames(vad, LOUD, 10)
    expect(vad.voicedDuration).toBeGreaterThanOrEqual(180)
    expect(vad.voicedDuration).toBeLessThan(300)
    // Silence adds nothing to the total.
    pushFrames(vad, SILENT, 5)
    expect(vad.voicedDuration).toBeLessThan(300)
    // The silence reaches the hangover and ends the utterance.
    pushFrames(vad, SILENT, 20)
    expect(vad.voicedDuration).toBe(0)
  })

  it('does not fire on a quiet sound while thresholdBoost is raised for the assistant own speech', () => {
    const { vad, got } = makeVad()
    pushFrames(vad, SILENT, 10)
    vad.thresholdBoost = 3
    // Stands for an echo that passes the plain threshold but not the boosted one.
    pushFrames(vad, 0.03, 20)
    expect(got.starts).toBe(0)
    // A real voice still gets through.
    pushFrames(vad, LOUD, 20)
    expect(got.starts).toBe(1)
  })

  it('starts capturing a noise with a low speech probability but never confirms it as an utterance', () => {
    const { vad, got } = makeVad()
    // Silero reports that this is not a human voice.
    vad.speechProbProvider = () => 0.1
    pushFrames(vad, SILENT, 10)
    // 500 ms, which the energy alone would take for speech.
    pushFrames(vad, LOUD, 25)
    // The start still fires immediately, on the energy alone.
    expect(got.starts).toBe(1)
    expect(vad.speechConfirmed).toBe(false)
    expect(vad.speechDuration).toBe(0)
    pushFrames(vad, SILENT, 18)
    // Nothing is handed to Whisper.
    expect(got.utterances).toHaveLength(0)
  })

  it('hands a short reply over to speech recognition although Silero confirms little of it', () => {
    const { vad, got } = makeVad()
    let prob = 0.9
    vad.speechProbProvider = () => prob
    pushFrames(vad, SILENT, 10)
    // 「はい」: 160 ms of voice, of which Silero takes the first 60 ms for speech.
    pushFrames(vad, LOUD, 4)
    prob = 0.2
    pushFrames(vad, LOUD, 4)
    // One word does not start the partial transcripts or the aizuchi.
    expect(vad.speechConfirmed).toBe(false)
    pushFrames(vad, SILENT, 18)
    expect(got.utterances).toHaveLength(1)
  })

  it('confirms the utterance as usual when the speech probability is high', () => {
    const { vad, got } = makeVad()
    vad.speechProbProvider = () => 0.9
    pushFrames(vad, SILENT, 10)
    pushFrames(vad, LOUD, 25)
    expect(vad.speechConfirmed).toBe(true)
    pushFrames(vad, SILENT, 18)
    expect(got.utterances).toHaveLength(1)
  })

  it('judges on energy alone while the provider is not ready and returns null', () => {
    const { vad, got } = makeVad()
    vad.speechProbProvider = () => null
    pushFrames(vad, SILENT, 10)
    pushFrames(vad, LOUD, 25)
    pushFrames(vad, SILENT, 18)
    expect(got.utterances).toHaveLength(1)
  })

  it('detects the start immediately during playback and reaches the barge-in thresholds once the probability rises', () => {
    const { vad, got } = makeVad()
    let prob = 0.1
    vad.speechProbProvider = () => prob
    // The assistant is speaking.
    vad.thresholdBoost = 3
    pushFrames(vad, SILENT, 10)
    // Stands for the roughly 60 ms Silero needs before its probability rises.
    pushFrames(vad, LOUD, 3)
    // Ducking starts immediately.
    expect(got.starts).toBe(1)
    prob = 0.9
    // The voice after the probability has risen.
    pushFrames(vad, LOUD, 15)
    // 250 ms is the energy threshold and 100 ms is the evidence of human speech; both are met.
    expect(vad.voicedDuration).toBeGreaterThanOrEqual(250)
    expect(vad.speechDuration).toBeGreaterThanOrEqual(100)
  })

  it('confirms the utterance when enough human speech accumulates, even when a noise came first', () => {
    const { vad, got } = makeVad()
    let prob = 0.1
    vad.speechProbProvider = () => prob
    pushFrames(vad, SILENT, 10)
    // 100 ms of noise.
    pushFrames(vad, LOUD, 5)
    prob = 0.9
    // 300 ms of speech.
    pushFrames(vad, LOUD, 15)
    expect(got.starts).toBe(1)
    pushFrames(vad, SILENT, 18)
    expect(got.utterances).toHaveLength(1)
  })
})

describe('VadSegmenter with the dynamic hangover from VAP', () => {
  it('ends early when a high EoT holds through the silence, cutting at about 300 ms even with a 600 ms setting', () => {
    const { vad, got } = makeVad(600)
    vad.eotProvider = () => 0.9
    pushFrames(vad, SILENT, 10)
    // 25 frames are 500 ms of speech.
    pushFrames(vad, LOUD, 25)
    // 320 ms of silence, with the high EoT lasting more than 200 ms.
    pushFrames(vad, SILENT, 16)
    expect(got.utterances).toHaveLength(1)
    expect(got.utterances[0].vadMs).toBeLessThan(400)
    expect(got.utterances[0].mode).toBe('early')
  })

  it('does not end early when the high EoT lasts under 200 ms, as a momentary spike does', () => {
    const { vad, got } = makeVad(600)
    let eot = 0.5
    vad.eotProvider = () => eot
    pushFrames(vad, SILENT, 10)
    pushFrames(vad, LOUD, 25)
    // 160 ms of silence while the EoT is in the middle.
    pushFrames(vad, SILENT, 8)
    eot = 0.9
    // 160 ms since the EoT went high, short of the 200 ms it must hold, so 320 ms in total does not cut.
    pushFrames(vad, SILENT, 8)
    expect(got.utterances).toHaveLength(0)
    // The high EoT holds, the hangover has shortened to 300 ms, and the utterance ends.
    pushFrames(vad, SILENT, 15)
    expect(got.utterances).toHaveLength(1)
  })

  it('extends the hangover to 900 ms through a low-EoT silence, which is a pause inside a sentence', () => {
    const { vad, got } = makeVad(600)
    vad.eotProvider = () => 0.1
    pushFrames(vad, SILENT, 10)
    pushFrames(vad, LOUD, 25)
    // 700 ms of silence: the 600 ms setting would have ended it, but the hangover is extended.
    pushFrames(vad, SILENT, 35)
    expect(got.utterances).toHaveLength(0)
    // 920 ms passes the extended 900 ms.
    pushFrames(vad, SILENT, 11)
    expect(got.utterances).toHaveLength(1)
    expect(got.utterances[0].mode).toBe('extended')
  })

  it('extends to 900 ms while the aizuchi classifier holds the turn, even when the EoT is high', () => {
    const { vad, got } = makeVad(600)
    vad.eotProvider = () => 0.9
    vad.holdProvider = () => true
    pushFrames(vad, SILENT, 10)
    pushFrames(vad, LOUD, 25)
    // 700 ms of silence: the EoT alone would have cut at 300 ms.
    pushFrames(vad, SILENT, 35)
    expect(got.utterances).toHaveLength(0)
    // 920 ms passes the extended 900 ms.
    pushFrames(vad, SILENT, 11)
    expect(got.utterances).toHaveLength(1)
    expect(got.utterances[0].mode).toBe('extended')
  })

  it('falls back to the fixed hangover while the provider is absent or returns null', () => {
    const { vad, got } = makeVad(600)
    vad.eotProvider = () => null
    pushFrames(vad, SILENT, 10)
    pushFrames(vad, LOUD, 25)
    // 620 ms passes the 600 ms hangover.
    pushFrames(vad, SILENT, 31)
    expect(got.utterances).toHaveLength(1)
    expect(got.utterances[0].vadMs).toBeGreaterThanOrEqual(600)
    expect(got.utterances[0].mode).toBe('fixed')
  })

  it('ends at the configured hangover with mode fixed when the EoT sits in the middle', () => {
    const { vad, got } = makeVad(600)
    vad.eotProvider = () => 0.5
    pushFrames(vad, SILENT, 10)
    pushFrames(vad, LOUD, 25)
    pushFrames(vad, SILENT, 31)
    expect(got.utterances).toHaveLength(1)
    expect(got.utterances[0].mode).toBe('fixed')
  })

  it('does not shorten a setting already below the early-end floor and keeps mode fixed', () => {
    const { vad, got } = makeVad(200)
    vad.eotProvider = () => 0.9
    pushFrames(vad, SILENT, 10)
    pushFrames(vad, LOUD, 25)
    // 220 ms passes the 200 ms hangover.
    pushFrames(vad, SILENT, 11)
    expect(got.utterances).toHaveLength(1)
    expect(got.utterances[0].mode).toBe('fixed')
  })

  it('keeps a short utterance of at least 250 ms voiced even when it ends early', () => {
    const { vad, got } = makeVad(600)
    vad.eotProvider = () => 0.9
    pushFrames(vad, SILENT, 10)
    // 320 ms of speech, about as long as "はい、おねがい".
    pushFrames(vad, LOUD, 16)
    // The early end comes at about 320 ms.
    pushFrames(vad, SILENT, 16)
    expect(got.utterances).toHaveLength(1)
  })
})
