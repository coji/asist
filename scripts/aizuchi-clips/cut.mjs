/**
 * Finds where an aizuchi read in front of the carrier sentence ends, and cuts it out.
 *
 * Every pause after the voice starts is a candidate end, from the first on. A cut is right when speech
 * recognition hears the carrier, whole, in what follows it: a cut at a pause inside the aizuchi (the one
 * after 「あ、」 in 「あ、そういうことですね。」) leaves part of the aizuchi in front of the carrier, and a cut
 * inside the carrier leaves it short.
 */

export const RATE = 24_000
export const FRAME = 480
export const VOICED_FRAME_RMS = 0.004
/** The carrier has no comma, so the only long pause of a reading after the aizuchi is the one before it. */
export const CARRIER = '今日は朝からとてもいい天気ですね。'
const TAIL_FRAMES = 5
/** Without a pause of 80 ms the aizuchi runs into the carrier and cannot be cut cleanly. */
const MIN_PAUSE_FRAMES = 4

/** The text without what a recognizer spells differently in an interjection: long vowels, the small tsu and small vowels. */
export function plain(text) {
  return text.replace(/[。、,.!?！？\s…ー〜っッぁぃぅぇぉ]/g, '')
}

export function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = row[j]
      row[j] = next
    }
  }
  return row[b.length]
}

/** The RMS of each frame of 20 ms. */
export function frameRms(audio) {
  const count = Math.floor(audio.length / FRAME)
  const rms = new Float32Array(count)
  for (let frame = 0; frame < count; frame++) {
    let sum = 0
    for (let i = frame * FRAME; i < (frame + 1) * FRAME; i++) sum += audio[i] * audio[i]
    rms[frame] = Math.sqrt(sum / FRAME)
  }
  return rms
}

/** The silent runs of at least MIN_PAUSE_FRAMES that start after `from` and end before the audio does. */
function pauses(voiced, from) {
  const found = []
  let start = null
  for (let index = from; index < voiced.length; index++) {
    if (!voiced[index] && start === null) start = index
    if (voiced[index] && start !== null) {
      if (index - start >= MIN_PAUSE_FRAMES) found.push({ start, length: index - start })
      start = null
    }
  }
  return found
}

/**
 * Cuts the aizuchi `head` out of a reading of head and carrier. `recognize` transcribes samples at RATE.
 * Returns the clip with how it was cut and what the recognizer heard in it, or the reason the reading
 * cannot be used.
 */
export async function cutAizuchi(audio, head, recognize) {
  const voiced = Array.from(frameRms(audio), (rms) => rms >= VOICED_FRAME_RMS)
  const onset = voiced.indexOf(true)
  if (onset < 0) return 'no voice'
  const spoken = plain(head).length || 1
  let reason = 'no pause before the carrier'
  for (const pause of pauses(voiced, onset)) {
    const seconds = ((pause.start - onset) * FRAME) / RATE
    // A natural aizuchi takes 0.06 to 0.45 s per character ("なるほどなるほど" at 0.09 s is a normal quick reading).
    if (seconds < 0.06 * spoken) continue
    if (seconds > 0.45 * spoken + 0.3) return reason === 'no pause before the carrier' ? `${seconds.toFixed(2)} s is not a natural length` : reason
    const end = (pause.start + Math.min(pause.length, TAIL_FRAMES)) * FRAME
    const rest = await recognize(audio.subarray(end))
    if (editDistance(plain(rest), plain(CARRIER)) > 1) {
      reason = `the carrier came back as "${rest}"`
      continue
    }
    const samples = audio.slice(Math.max(0, onset - 1) * FRAME, end)
    const heard = await recognize(samples)
    return { samples, end, pauseMs: pause.length * 20, voicedMs: (pause.start - onset) * 20, heard }
  }
  return reason
}
