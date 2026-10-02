import type { AizuchiClip } from '@shared/ipc'
import type { BackchannelKind } from '@shared/listening-aizuchi'
import { categoryOfClassification, type AizuchiClassification } from '@shared/aizuchi-classifier'
import { pickWeightedClip } from '@shared/aizuchi-clips'

/**
 * The renderer's cache of the aizuchi bank. Holding the clips that the main process synthesized in
 * advance is what lets playback start tens of milliseconds after end of speech is detected. A clip
 * is drawn at random with weights from its corpus frequency, and the previous clip is excluded so
 * the same one does not repeat.
 */

let bank: AizuchiClip[] = []
let lastText = ''
let loadGeneration = 0

/**
 * Called at startup and whenever main reports that it threw the bank away. Main answers with an empty
 * bank in a language without aizuchi. While the load fails, the conversation goes on with no aizuchi.
 */
export async function loadAizuchiBank(): Promise<void> {
  const generation = ++loadGeneration
  bank = []
  lastText = ''
  try {
    const clips = await window.api.aizuchiBank()
    if (generation === loadGeneration) bank = clips
  } catch (error) {
    console.error('aizuchi bank failed to load:', error)
  }
}

/**
 * Picks the clip for the aizuchi that opens a turn, or nothing. Whether the turn opens with one at all
 * is the caller's to decide. Without a classification nothing plays, and no rule over the text stands
 * in for one; the same holds when the category has no clip.
 */
export function pickAizuchi(classification: AizuchiClassification | null): AizuchiClip | null {
  const category = categoryOfClassification(classification)
  if (category === null) return null
  const clip = pickWeightedClip(bank.filter((c) => c.category === category), { excludeText: lastText })
  if (clip) lastText = clip.text
  return clip
}

/** The longest assessment clip, such as "なるほど。" or "確かに。", that plays while the user speaks without talking over them. */
const ASSESSMENT_MAX_CHARS = 6

/**
 * Picks an aizuchi to play while the user is still speaking; only clips that carry audio qualify.
 * A continuer comes from the 'flow' category ("うん", "はい"), an assessment from the short clips of
 * the 'understand' and 'agree' categories ("なるほど", "確かに").
 */
export function pickListeningClip(kind: BackchannelKind = 'continuer'): AizuchiClip | null {
  const candidates = bank.filter(
    (c) =>
      c.audio &&
      (kind === 'assessment'
        ? (c.category === 'understand' || c.category === 'agree') &&
          c.text.length <= ASSESSMENT_MAX_CHARS
        : c.category === 'flow')
  )
  const clip = pickWeightedClip(candidates, { excludeText: lastText })
  if (clip) lastText = clip.text
  return clip
}
