/**
 * The PDF viewer's cases. In six runs of each on an M5 under a load average of 15 to 50 on 2026-10-02, the card
 * showed page 1 in 0.4 to 2.5 s, most of it the preview frame starting and loading pdf.js and its worker as the
 * demo's development server serves them, and the focus view showed its first screen in 0.1 to 0.3 s and every
 * later screen within 0.18 s. The renderers grew by 0.37 to 0.6 GB at the peak, the preview frame's process holding
 * 0.2 to 0.3 GB of it with a document open, and the GPU process by 0.08 to 0.17 GB. The main thread was held for
 * 0.03 to 0.14 s, and up to 0.42 s in the runs under the heaviest load.
 *
 * Every page in view has to be drawn. The viewer gives a canvas only to the pages within a screen of the view, and
 * the rest are blank boxes of their size, so a screen can show a drawn page beside one still blank, which the
 * default check takes for shown because it finds a drawn canvas somewhere in view. A page is drawn once its canvas
 * holds pdf.js's bitmap, which is opaque paper; a canvas still waiting for it is transparent.
 */
function everyPageInViewDrawn(root) {
  const frame = root.querySelector('.fv-frame')
  if (!frame || window.__budgetRefusal(root)) return false
  const clips = [root, frame.querySelector('.fv-scroll') ?? frame].map((el) => el.getBoundingClientRect())
  const top = Math.max(0, ...clips.map((clip) => clip.top))
  const bottom = Math.min(innerHeight, ...clips.map((clip) => clip.bottom))
  const pages = [...frame.querySelectorAll('.fv-pdf-page')].filter((page) => {
    const box = page.getBoundingClientRect()
    return Math.min(box.bottom, bottom) - Math.max(box.top, top) >= 1
  })
  if (pages.length === 0) return false
  const sample = (window.__pdfBudgetSample ??= new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true }))
  sample.imageSmoothingQuality = 'high'
  return pages.every((page) => {
    const canvas = page.querySelector('canvas')
    if (!canvas) return false
    sample.clearRect(0, 0, 1, 1)
    sample.drawImage(canvas, 0, 0, 1, 1)
    return sample.getImageData(0, 0, 1, 1).data[3] === 255
  })
}

const budget = {
  cardFirstMs: 1500,
  cardHeldMs: 150,
  cardPeakMb: 350,
  focusFirstMs: 1000,
  focusHeldMs: 150,
  slowestScreenMs: 400,
  peakMb: 700,
  finalMb: 400,
  gpuPeakMb: 300
}

export const cases = [
  { name: 'pdf-200', file: 'pdf-200', shown: everyPageInViewDrawn, budget },
  { name: 'pdf-1000', file: 'pdf-1000', shown: everyPageInViewDrawn, budget }
]
