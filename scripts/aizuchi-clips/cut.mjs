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
/**
 * The level down to which the start of the voice is followed back from the first voiced frame. A breathy
 * onset such as the "h" of "はい" stays under VOICED_FRAME_RMS for tens of milliseconds, and a cut one frame
 * before the first voiced frame took the head off "はいはい。" and "そうですね、" (heard on 2026-10-01).
 */
const ONSET_RMS = 0.001
const MAX_LEAD_FRAMES = 10
/** Without a pause of 80 ms the aizuchi runs into the carrier and cannot be cut cleanly. */
const MIN_PAUSE_FRAMES = 4

/** The vowel of each kana, which a long vowel mark after it stands for. */
const VOWEL = Object.fromEntries(
  ['あかさたなはまやらわがざだばぱゃアカサタナハマヤラワガザダバパャ', 'いきしちにひみりぎじぢびぴイキシチニヒミリギジヂビピ', 'うくすつぬふむゆるぐずづぶぷゅウクスツヌフムユルグズヅブプュ', 'えけせてねへめれげぜでべぺエケセテネヘメレゲゼデベペ', 'おこそとのほもよろをごぞどぼぽょオコソトノホモヨロヲゴゾドボポョ']
    .flatMap((row) => [...row].map((kana) => [kana, row[0]]))
)

/**
 * The text without what a recognizer spells differently in an interjection: punctuation, the small tsu and
 * small vowels. A long vowel mark is read as the vowel it draws out, so that "あー" and "ああ" are the same and
 * neither is "あ".
 */
export function plain(text) {
  const drawn = [...text].map((char, index, chars) => (char === 'ー' ? VOWEL[chars[index - 1]] ?? '' : char)).join('')
  return drawn.replace(/[。、,.!?！？\s…〜っッぁぃぅぇぉ]/g, '')
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

/** The first frame of the voice that starts at `onset`, followed back through a quiet breathy start. */
function leadIn(rms, onset) {
  let start = onset
  while (start > 0 && onset - start < MAX_LEAD_FRAMES && rms[start - 1] >= ONSET_RMS) start--
  return Math.max(0, start - 1)
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
  const rms = frameRms(audio)
  const voiced = Array.from(rms, (value) => value >= VOICED_FRAME_RMS)
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
    const samples = audio.slice(leadIn(rms, onset) * FRAME, end)
    const heard = await recognize(samples)
    return { samples, end, pauseMs: pause.length * 20, voicedMs: (pause.start - onset) * 20, heard }
  }
  return reason
}

/**
 * A short sound this long or less after a pause this long or more, at the end of a reading alone, is not part
 * of the aizuchi: Irodori-TTS left an 80 ms blip 0.3 to 0.4 s after "あー。", "えっと、" and "はいはい。"
 * (heard on 2026-10-01), while the pause inside "あ、失礼しました。" is followed by most of the words.
 */
const STRAY_FRAMES = 10
const STRAY_PAUSE_FRAMES = 10

/** The last voiced frame of a reading, leaving out short stray sounds after a long pause at its end. */
function lastVoice(voiced, onset) {
  let last = voiced.lastIndexOf(true)
  for (;;) {
    let start = last
    while (start > onset && voiced[start - 1]) start--
    let gap = start
    while (gap > onset && !voiced[gap - 1]) gap--
    if (start === onset || last - start + 1 > STRAY_FRAMES || start - gap < STRAY_PAUSE_FRAMES) return last
    last = gap - 1
  }
}

/**
 * An aizuchi read alone, as Irodori-TTS can read one without rambling, with the silence around it cut as the
 * app's SpeechShaper cuts a sentence: the start of the voice kept and a short tail after the last of it.
 */
export async function trimAizuchi(audio, head, recognize) {
  const rms = frameRms(audio)
  const voiced = Array.from(rms, (value) => value >= VOICED_FRAME_RMS)
  const onset = voiced.indexOf(true)
  if (onset < 0) return 'no voice'
  const last = lastVoice(voiced, onset)
  const seconds = ((last + 1 - onset) * FRAME) / RATE
  // Irodori-TTS fixes the length before it speaks, so this only refuses a reading far past any natural one;
  // "えっと、" took 1.26 s, with the breath of its comma.
  if (seconds > 0.5 * (plain(head).length || 1) + 1) return `${seconds.toFixed(2)} s is not a natural length`
  const samples = audio.slice(leadIn(rms, onset) * FRAME, Math.min(voiced.length, last + 1 + TAIL_FRAMES) * FRAME)
  const heard = await recognize(samples)
  return { samples, pauseMs: 0, voicedMs: (last + 1 - onset) * 20, heard }
}
