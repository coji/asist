/**
 * The Word viewer on a 300-page report with 100 photos (61 MB). The focus view shows the head of the document first
 * and a loading note below it until the rest is mounted, so the default check, which waits for every loading note
 * in the frame, would time the whole document rather than what is in view. This check is the default one with the
 * loading note counted only where it can be seen: a screen at the end of the head is shown once the rest is there.
 *
 * Measured on an M5 on 2026-10-02. Before the viewer was made light, with #198's limit lifted and a load average
 * of 6, mammoth read every photo in the page: the card and the focus view took 23.6 s and 23.2 s, held the page for
 * 742 ms and 697 ms, and grew it by 2.5 GB at the peak. After, in four runs under a load average of 26 to 42, the
 * card took 196 to 450 ms and the focus view 150 to 242 ms; the card held the page for at most 23 ms and the focus
 * view for 73 to 245 ms, the longest under the heaviest load, while a trace found no task over 34 ms; the slowest
 * screen took 70 to 81 ms; the renderers grew by 186 to 189 MB with the card, of which the preview page's process is
 * about 170 MB, by 377 to 434 MB at the peak and 141 to 292 MB at the end, and the GPU process by 67 to 87 MB.
 */
export const cases = [
  {
    name: 'docx-300',
    file: 'docx-300',
    shown: (root) => {
      const frame = root.querySelector('.fv-frame')
      if (!frame || window.__budgetRefusal(root)) return false
      const clips = [root, frame.querySelector('.fv-scroll') ?? frame].map((el) => el.getBoundingClientRect())
      const area = {
        top: Math.max(0, ...clips.map((c) => c.top)),
        bottom: Math.min(innerHeight, ...clips.map((c) => c.bottom)),
        left: Math.max(0, ...clips.map((c) => c.left)),
        right: Math.min(innerWidth, ...clips.map((c) => c.right))
      }
      if (area.bottom <= area.top || area.right <= area.left) return false
      const inView = (el) => {
        const r = el.getBoundingClientRect()
        return Math.min(r.bottom, area.bottom) - Math.max(r.top, area.top) >= 1 && Math.min(r.right, area.right) - Math.max(r.left, area.left) >= 1
      }
      const loading = window.demoText('files.viewer.loading')
      if ([...frame.querySelectorAll('.fv-note')].some((note) => note.textContent.trim() === loading && inView(note))) return false
      const sample = (window.__budgetSample ??= new OffscreenCanvas(16, 16).getContext('2d', { willReadFrequently: true }))
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
      for (const canvas of frame.querySelectorAll('canvas')) if (inView(canvas) && !drawn(canvas)) return false
      const aside = '.fv-note, .fv-stub, button'
      for (let row = 1; row <= 4; row++) {
        for (let column = 1; column <= 4; column++) {
          const hit = document.elementFromPoint(area.left + ((area.right - area.left) * column) / 5, area.top + ((area.bottom - area.top) * row) / 5)
          if (!hit || !frame.contains(hit) || hit.closest(aside)) continue
          if (hit instanceof HTMLCanvasElement || [...hit.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '')) return true
        }
      }
      return false
    },
    budget: { cardFirstMs: 1000, cardHeldMs: 150, cardPeakMb: 250, focusFirstMs: 1000, focusHeldMs: 150, slowestScreenMs: 500, peakMb: 600, finalMb: 350, gpuPeakMb: 200 }
  }
]
