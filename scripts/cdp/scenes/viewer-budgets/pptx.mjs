/**
 * The PowerPoint viewer reads the deck by ranges and draws only the slides within a screen of the view, each
 * picture on a canvas at the size it is drawn. The default check hit-tests 16 points of the view, and on a slide of
 * bullet points all of them can fall between the lines of its text box, where nothing has text of its own, so this
 * case looks at the slides instead: every slide in view holds its text, and every canvas in view, a picture, is
 * drawn. Every slide of the generated deck has a title.
 *
 * In five runs on an M5 under load averages of 6 to 25 on 2026-10-02, the card showed the 146 MB deck in 105 to
 * 259 ms, held the page for at most 20 ms and grew the renderers by 174 to 178 MB, most of it the preview frame's
 * process, which the demo serves with Vite's development modules. The focus view showed its first screen in 115 to
 * 241 ms and each of 120 screens in at most 229 ms, held the page for 74 to 106 ms (472 ms once, under a load of 22),
 * and grew the renderers by 365 to 386 MB at the peak and 155 to 289 MB at the end, the GPU process by 82 to 98 MB.
 */
export const cases = [
  {
    name: 'pptx-200',
    file: 'pptx-200',
    shown: (root) => {
      const frame = root.querySelector('.fv-frame')
      if (!frame) return false
      const loading = window.demoText('files.viewer.loading')
      if ([...frame.querySelectorAll('.fv-note')].some((note) => note.textContent.trim() === loading)) return false
      const clips = [root, frame.querySelector('.fv-scroll') ?? frame].map((el) => el.getBoundingClientRect())
      const top = Math.max(0, ...clips.map((clip) => clip.top))
      const bottom = Math.min(innerHeight, ...clips.map((clip) => clip.bottom))
      const inView = (el) => {
        const box = el.getBoundingClientRect()
        return Math.min(box.bottom, bottom) - Math.max(box.top, top) >= 1
      }
      const sample = (window.__pptxSample ??= new OffscreenCanvas(16, 16).getContext('2d', { willReadFrequently: true }))
      sample.imageSmoothingQuality = 'high'
      const drawn = (canvas) => {
        if (canvas.width === 0 || canvas.height === 0) return false
        sample.clearRect(0, 0, 16, 16)
        sample.drawImage(canvas, 0, 0, 16, 16)
        const data = sample.getImageData(0, 0, 16, 16).data
        for (let i = 4; i < data.length; i += 4) {
          if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2] || data[i + 3] !== data[3]) return true
        }
        return false
      }
      const slides = [...frame.querySelectorAll('.fv-pptx-slide')].filter(inView)
      return slides.length > 0 && slides.every((slide) => slide.querySelector('.fv-pptx-para') !== null && [...slide.querySelectorAll('canvas')].filter(inView).every(drawn))
    },
    budget: { cardFirstMs: 1000, cardHeldMs: 150, cardPeakMb: 300, focusFirstMs: 1000, focusHeldMs: 150, slowestScreenMs: 500, peakMb: 600, finalMb: 450, gpuPeakMb: 300 }
  }
]
