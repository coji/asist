// Scene 8, beat 67 to 71: morning rises from the bottom, the count runs up to 11 and the names of the
// eleven languages orbit a globe. It leaves under three coloured bands that sweep across the screen.
scene(() => {
  const S = 67
  const b = (k) => B(S + k)
  const s = $('#s8')
  const cam = camera(s)
  // The three bands cover the screen at this moment, and scene 9 is switched in under them.
  const cover = b(4) - 0.02
  show(s, b(-0.5), cover + 0.01)
  waveWipe(s, b(-0.4), b(0.4), 'up', { amp: 34 })
  cue(b(-0.4), 'morning')

  pop('#s8-globe', b(0.1), { from: 0.2, rotFrom: -40, rot: 0, dur: 0.7 })
  tl.to('#s8-globe', { rotation: 8, duration: BEAT * 2, ease: 'sine.inOut', yoyo: true, repeat: 1 }, b(1))
  cue(b(0.1), 'pop', { i: 14 })

  const langs = $$('.lang', s)
  const c = { x: 520, y: 545 }
  const appear = langs.map((_, k) => b(0.35) + k * 0.085)
  cue(appear[0], 'count', { n: langs.length, dur: appear[langs.length - 1] - appear[0] })
  const backOut = (x) => {
    const k = 2.2
    const u = x - 1
    return 1 + (k + 1) * u * u * u + k * u * u
  }
  onFrame((t) => {
    langs.forEach((el, k) => {
      const a = clamp01((t - appear[k]) / 0.4)
      if (a <= 0 || t > b(4.2)) {
        el.style.visibility = 'hidden'
        return
      }
      el.style.visibility = 'visible'
      const th = (k / langs.length) * Math.PI * 2 + (t - b(0)) * 0.8
      const d = Math.sin(th)
      const x = c.x + Math.cos(th) * 350
      const y = c.y + d * 185 + (1 - a) * 60
      const sc = (0.8 + 0.2 * d) * backOut(a)
      el.style.zIndex = d > 0 ? 10 : 1
      el.style.opacity = String((0.6 + 0.4 * (d + 1) / 2) * Math.min(1, a * 2))
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) scale(${sc.toFixed(3)})`
    })
  })

  const n = { v: 1 }
  tl.to(n, { v: 11, duration: appear[10] - appear[0], ease: 'none' }, appear[0])
  const num = $('#s8-n')
  onFrame(() => {
    num.textContent = String(Math.max(1, Math.round(n.v)))
  })
  tl.fromTo('#s8-n', { scale: 0.6, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.4, ease: 'back.out(2)' }, b(0.2))
  tl.to('#s8-n', { scale: 1.15, duration: 0.12, ease: 'power2.out', yoyo: true, repeat: 1, transformOrigin: '80% 70%' }, appear[10] + 0.05)
  kinetic(chars($('#s8-l1 .u')), b(0.6), 'pop', { stagger: 0.05, y: 60 })
  kinetic(chars($('#s8-l2')), b(1.3), 'pop', { stagger: 0.06, y: 60 })
  rise('#s8-sub', b(2), { y: 26 })
  const fx = overlay($('#s8-world'), 20)
  burst(fx, 1260, 400, appear[10] + 0.05, { r: 170, color: '#3f6fe0', sparks: 12 })
  cue(appear[10] + 0.05, 'pop', { i: 15 })
  tl.to(cam, { s: 1.05, duration: b(4.2) - b(0), ease: 'none' }, b(0))

  // The bands leave in the reverse of the order they came in, so each colour shows in turn over scene 9.
  const bands = ['#3f6fe0', '#8fb0ff', '#dfeaff'].map((color, k) => {
    const b = document.createElement('div')
    b.className = 'band'
    b.style.background = color
    b.style.zIndex = 96 + k
    $('#stage').appendChild(b)
    const tIn = cover - 0.5 - (2 - k) * 0.13
    const tOut = cover + 0.03 + (2 - k) * 0.13
    gate(b, tIn, tOut + 0.55)
    tl.fromTo(b, { x: -2950 }, { x: -340, duration: 0.5, ease: 'power2.inOut', immediateRender: false }, tIn)
    tl.to(b, { x: 2350, duration: 0.5, ease: 'power2.inOut' }, tOut)
    return b
  })
  cue(cover - 0.66, 'whoosh')
})
