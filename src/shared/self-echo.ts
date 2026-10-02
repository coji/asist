import { searchTokens } from './memory-search'
import type { SpeechSegment } from './ipc'

/**
 * Detects self-echo: the assistant's own speech coming back through the microphone, getting
 * transcribed, and making the assistant reply to itself. This is the last line of defense for the
 * cases that get past echo cancellation and the VAD threshold boost.
 */

/** How long reverberation and the tail of the echo linger in the microphone after playback ends. */
export const ECHO_TAIL_MS = 250

/** A sound ended this long ago cannot reach a capture that is still to be judged: a capture lasts at most 20 s, and its transcript follows within seconds. */
const PLAYBACK_KEEP_MS = 60_000

interface Sound {
  text: string
  clip: boolean
  from: number
  /** Infinity while the sound is still playing. */
  to: number
}

/**
 * A capture as the VAD timed it: speech began at `startedAt`, the voice was last heard at `speechEndAt`,
 * and the capture closed at `endedAt`, after the silence of the hangover.
 */
export interface CaptureSpan {
  startedAt: number
  speechEndAt: number
  endedAt: number
}

/** The texts of the clips that can sit at the start and at the end of a capture's transcript. */
export interface ClipEdges {
  leading: string[]
  trailing: string[]
}

/**
 * What the speaker played and when, which tells what the microphone can have picked up during a
 * capture: a sound reaches it only while it plays and for the echo tail after. An answer that
 * repeats a word of the question once the question has finished is therefore never taken for its
 * echo, and a clip that starts after the capture ended, such as the aizuchi played at speech end, is
 * never stripped from it. Playback is sequential, so a sound ends when its audio ends, when the next
 * one starts or when playback stops.
 */
export class PlaybackLog {
  private sounds: Sound[] = []

  /** A segment started sounding at `at`. */
  started(segment: Pick<SpeechSegment, 'text' | 'clip'>, at: number): void {
    this.stopped(at)
    this.sounds = this.sounds.filter((sound) => at - sound.to < PLAYBACK_KEEP_MS)
    this.sounds.push({ text: segment.text, clip: segment.clip !== undefined, from: at, to: Infinity })
  }

  /** The sound playing came to its end, or playback stopped, at `at`. */
  stopped(at: number): void {
    const last = this.sounds.at(-1)
    if (last && last.to === Infinity) last.to = at
  }

  /** The texts that played, or were still echoing, at some moment of the capture. */
  heardDuring(capture: Pick<CaptureSpan, 'startedAt' | 'endedAt'>): string[] {
    return this.sounds
      .filter((sound) => this.reaches(sound, capture.startedAt, capture.endedAt))
      .map((sound) => sound.text)
  }

  /**
   * The clips, such as an aizuchi, that can have leaked into either end of the capture's transcript. A
   * clip can lead it only if it was sounding when the speech began, and end it only if it was still
   * sounding, or echoing, when the voice was last heard. One that played at a break inside the speech,
   * as a listening aizuchi does, lands inside the transcript, so the same words at its start or end are
   * the user's own.
   */
  clipsAtEdges(capture: CaptureSpan): ClipEdges {
    const clips = this.sounds.filter((sound) => sound.clip && this.reaches(sound, capture.startedAt, capture.endedAt))
    return {
      leading: clips.filter((sound) => sound.from <= capture.startedAt).map((sound) => sound.text),
      trailing: clips.filter((sound) => sound.to + ECHO_TAIL_MS > capture.speechEndAt).map((sound) => sound.text)
    }
  }

  /** Whether the sound played, or was still echoing, at some moment from `from` to `to`. */
  private reaches(sound: Sound, from: number, to: number): boolean {
    return sound.text !== '' && sound.from < to && sound.to + ECHO_TAIL_MS > from
  }
}

export function normalizeForEcho(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}

/**
 * Whether the utterance is an echo of the assistant speech PlaybackLog reports as heard during its
 * capture. The text alone cannot tell an answer that repeats a word of the question from the
 * question's echo, which is why only what sounded during the capture is passed. Besides full
 * containment it accepts a token overlap of 85%, because ASR output varies between passes. The tokens
 * are the ones memory search cuts, so a language written with spaces is compared word by word instead
 * of across its word edges. Very short utterances, such as an aizuchi, are never treated as an echo:
 * the risk of a false positive is too high.
 */
export function isSelfEcho(utterance: string, recentAssistantTexts: readonly string[]): boolean {
  const u = normalizeForEcho(utterance)
  if (u.length < 4) return false
  // The replies are read as one text because an echo can start in one reply and end in the next. The space
  // between them keeps the last word of one reply from being read as one word with the first of the next,
  // and it changes nothing in Japanese: normalizeForEcho drops it and a bigram is cut across it.
  const joined = recentAssistantTexts.join(' ')
  const r = normalizeForEcho(joined)
  if (r.length === 0) return false
  if (r.includes(u)) return true
  const ut = new Set(searchTokens(utterance))
  if (ut.size === 0) return false
  const rt = new Set(searchTokens(joined))
  let hit = 0
  for (const token of ut) if (rt.has(token)) hit++
  return hit / ut.size >= 0.85
}

const EDGE_PUNCT = '[\\s\\p{P}]*'
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Removes an aizuchi clip such as "はい。" or "うん" that was played over the speaker while the
 * utterance was being captured and ended up at an edge of the transcription. isSelfEcho ignores short
 * texts to avoid false positives, so short aizuchi are handled here instead, and the caller passes
 * the clips PlaybackLog reports as able to sit at each edge.
 *
 * - Only a clip matched at the start or the end is stripped. A match inside the sentence is left
 *   alone, so that an utterance such as "じゃあはいって返事して" survives intact.
 * - An empty result means the whole utterance was an echo, and the caller discards it.
 */
export function stripClipEcho(utterance: string, clips: ClipEdges): string {
  const lead = clipAlternatives(clips.leading)
  const tail = clipAlternatives(clips.trailing)
  let rest = utterance
  // The candidates are lowercased while the utterance is not, and a transcript capitalizes its first word.
  if (lead) rest = rest.replace(new RegExp(`^(?:${EDGE_PUNCT}(?:${lead})${EDGE_PUNCT})+`, 'iu'), '')
  if (tail) rest = rest.replace(new RegExp(`(?:${EDGE_PUNCT}(?:${tail})${EDGE_PUNCT})+$`, 'iu'), '')
  return rest.trim()
}

/** The clips as the alternatives of a pattern, the longest first so that a doubled aizuchi is not read as the short one twice. */
function clipAlternatives(clipTexts: readonly string[]): string | null {
  const cands = [...new Set(clipTexts.map(normalizeForEcho).filter((t) => t.length > 0))].sort(
    (a, b) => b.length - a.length
  )
  return cands.length > 0 ? cands.map(escapeRegex).join('|') : null
}
