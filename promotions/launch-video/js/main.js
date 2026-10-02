// Builds the scenes once the fonts and images are ready and wires the timeline to render.mjs.
// index.html#play plays it in real time; index.html#t=12.5 stops at 12.5 s.
// The last chord of the music has died away 57 s into it.
const DURATION = M(57)

window.__duration = DURATION
window.__music = MUSIC
window.__seek = (t) => {
  tl.seek(t, false)
  for (const h of hooks) h(t)
  return 0
}
window.__ready = (async () => {
  const text = document.body.innerText
  await Promise.all(['900 80px "Zen Maru Gothic"', '700 40px "Zen Maru Gothic"', '500 30px "Zen Maru Gothic"', '500 30px "Zen Kaku Gothic New"',
    '700 30px "Zen Kaku Gothic New"', '400 40px Yomogi'].map((f) => document.fonts.load(f, text)))
  await document.fonts.ready
  await Promise.all([...document.images].map((i) => i.decode().catch(() => {})))
  for (const build of builders) build()
  tl.to({}, { duration: 0 }, DURATION)
  window.__cues = cues.sort((a, b) => a.t - b.t)
  return true
})()

if (location.hash === '#play') {
  window.__ready.then(() => {
    const start = performance.now()
    gsap.ticker.add(() => __seek(Math.min(DURATION, (performance.now() - start) / 1000)))
  })
} else if (location.hash.startsWith('#t=')) {
  window.__ready.then(() => __seek(parseFloat(location.hash.slice(3))))
}
