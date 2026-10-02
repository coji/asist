/**
 * Long recordings, whose waveform the preview page builds while it reads the file from its start, and which the card
 * draws as the peaks come. The content counts as shown once the first peaks are drawn, rather than when the flat line
 * the card draws before them is, and the card is complete once the whole waveform is drawn: a two-hour recording
 * within 20 s, a one-hour one within 10 s. The memory includes the preview page's frame, which in headless Chrome
 * holds about 160 MB with a five-second WAV open, and stays while the card shows the recording.
 *
 * In one run each on an M5 under a load average of 18 on 2026-10-02, the card drew its first peaks in 131 to 174 ms
 * and its whole waveform in 13.0 s for the two-hour MP3, 4.2 s for the one-hour m4a and 3.0 s for the one-hour WAV,
 * held the page for at most 38 ms, and grew the renderers by 260 to 274 MB at the peak and 181 to 204 MB at the end.
 */
const budget = { cardFirstMs: 1000, cardHeldMs: 150, focusFirstMs: 1000, focusHeldMs: 150, peakMb: 400, finalMb: 300, gpuPeakMb: 100 }

export const cases = [
  ['mp3-2h', 20_000],
  ['m4a-1h', 10_000],
  ['wav-1h', 10_000]
].map(([file, completeMs]) => ({
  name: file,
  file,
  shown: (root) => ['drawing', 'ready'].includes(root.querySelector('.fv-media-wave')?.getAttribute('data-state')),
  complete: (root) => root.querySelector('.fv-media-wave')?.getAttribute('data-state') === 'ready',
  budget: { ...budget, completeMs }
}))
