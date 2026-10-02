// Scene 9, beat 71 to the end: the call to action over the landscape of the site, with the clouds and
// the land moving at different depths. From here the music slows down to its last chord, so the steps
// follow note onsets measured in the music with tools/ending.py instead of the beat grid.
scene(() => {
  const T = {
    start: B(71), logo: M(49.76), head: M(50.085), sub: M(50.77), url: M(51.513), meta: M(52.245), bubble: M(52.628),
    flourish: M(53.058), last: M(54.729),
  }
  const s = $('#s9')
  const cam = camera(s)
  const fx = overlay($('#s9-front'), 0)
  // Behind the text of the block, so that the twinkles never cross the letters.
  const sparkle = canvasLayer($('#s9-front'), -1)
  show(s, T.start - 0.02)
  const rain = canvasLayer($('#s9-land'), 2)

  tl.fromTo('#s9-img', { y: 300 }, { y: 0, duration: 1.4, ease: 'expo.out' }, T.start)
  $$('.s9-cloud').forEach((el, i) => {
    tl.fromTo(el, { x: i % 2 ? 160 : -160, autoAlpha: 0 }, { x: 0, autoAlpha: 1, duration: 1.2, ease: 'expo.out' }, T.start + i * 0.1)
    tl.to(el, { x: i % 2 ? -50 : 60, duration: DURATION - T.start - 1.3, ease: 'none' }, T.start + 1.3)
  })
  tl.to(cam, { s: 1.05, y: -12, duration: DURATION - T.logo, ease: 'power1.inOut' }, T.logo)

  pop('#s9-logo', T.logo, { from: 0.3 })
  burst(fx, 960, 140, T.logo, { r: 160, color: '#7aa0ff', sparks: 10 })
  cue(T.logo, 'logo')
  kinetic(chars($('#s9-h')), T.head, 'pop', { stagger: 0.045, y: 80 })
  cue(T.head, 'type', { n: 10, dur: 0.45 })
  rise('#s9-sub', T.sub, { y: 26 })

  pop('#s9-url', T.url, { from: 0.4, dur: 0.7 })
  burst(fx, 960, 470, T.url, { r: 260, color: '#3f6fe0', sparks: 14, width: 8 })
  cue(T.url, 'cta')
  for (const t of [T.url + 0.7, T.last]) tl.fromTo('#s9-shine', { xPercent: -150 }, { xPercent: 380, duration: 0.7, ease: 'power2.inOut' }, t)
  for (const t of [T.flourish, T.last]) tl.to('#s9-url', { scale: 1.05, duration: 0.3, ease: 'sine.inOut', yoyo: true, repeat: 1 }, t)
  rise('#s9-meta', T.meta, { y: 20 })
  pop('#s9-bubble', T.bubble, { from: 0.3, origin: '90% 110%', rotFrom: 12, rot: 4 })
  cue(T.bubble, 'reply')
  twinkles(sparkle, { x: 420, y: 60, w: 1080, h: 560 }, T.url + 0.2, DURATION + 1, { n: 26, size: 16, color: '#ffffff', seed: 19 })
  confettiRain(rain, T.flourish, DURATION + 1, { n: 90, seed: 23 })
  cue(T.flourish, 'sparkle')
})
