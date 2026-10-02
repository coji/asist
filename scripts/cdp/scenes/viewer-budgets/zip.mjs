/**
 * A zip is shown as a plain file and is never read, however large it is: its content is the placard that names it
 * as a file without a viewer, which the default check would take for a viewer that refused. In six runs on an M5
 * under a load average of 13 on 2026-10-02, the card and the focus view showed a 200 MB zip in 7 to 17 ms, held
 * the page for at most 8 ms, and grew the renderer by 20 to 25 MB at the peak and 15 to 21 MB at the end; a
 * viewer that read the file would grow it by more than the file's size.
 */
export const cases = [
  {
    name: 'zip',
    file: 'zip',
    shown: (root) => {
      const placard = root.querySelector('.fv-stub')
      return placard !== null && !placard.textContent.includes(window.demoText('files.viewer.tooLarge'))
    },
    budget: { cardFirstMs: 500, cardHeldMs: 100, focusFirstMs: 500, focusHeldMs: 100, peakMb: 80, finalMb: 60 }
  }
]
