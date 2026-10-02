// Scene 3, beat 15 to 27: three questions, each answered by a card that flips in, then all eight cards
// form a turning 3D ring, which scatters outwards as scene 4 comes out of its centre.
scene(() => {
  const S = 15
  const b = (k) => B(S + k)
  const s = $('#s3')
  const cam = camera(s)
  show(s, b(-0.4), b(12.6))
  tl.fromTo(s, { yPercent: 100 }, { yPercent: 0, duration: b(0.6) - b(-0.4), ease: 'power3.inOut' }, b(-0.4))

  const R = 640
  const ring = $('#s3-ring')
  const card = {}
  for (const el of $$('.rc', ring)) {
    const img = $('.front', el)
    const h = (300 * img.naturalHeight) / img.naturalWidth
    gsap.set(el, { top: -h / 2 })
    card[el.id.slice(3)] = el
  }
  gsap.set(ring, { z: -R, rotationX: 0, rotationY: 0 })
  gsap.set($$('.rc', ring), { autoAlpha: 0 })

  // Poses are in the ring's own space. The ring sits R behind the screen plane, so z = R is on the screen.
  const presented = { x: 360, y: 20, z: R + 220, rotationY: 0, scale: 1 }
  const leftBack = { x: 110, y: 10, z: R - 280, rotationY: 30, scale: 1 }
  const rightBack = { x: 640, y: 10, z: R - 280, rotationY: -30, scale: 1 }
  const order = ['weather', 'fx', 'todo', 'news', 'timer', 'map', 'calendar', 'mail-draft']
  const ringPose = (id) => {
    const a = order.indexOf(id) * 45
    const r = (a * Math.PI) / 180
    return { x: R * Math.sin(r), y: 0, z: R * Math.cos(r), rotationY: a, scale: 1 }
  }

  tl.fromTo('#s3-mk', { '--mk': 0 }, { '--mk': 1, duration: 0.5, ease: 'power2.inOut' }, b(0.7))
  cue(b(0.7), 'marker')
  rise('#s3-h3', b(1), { y: 30 })
  rise('#s3-sub', b(1.4), { y: 24 })

  const qs = [['#s3-q0', 'weather', b(1)], ['#s3-q1', 'fx', b(3)], ['#s3-q2', 'mail-draft', b(5)]]
  qs.forEach(([q, id, t], k) => {
    pop(q, t, { from: 0.3, origin: '10% 110%', rotFrom: -7, rot: -2 })
    voiceBars($(q + ' .bars'), t + 0.05, t + 0.85, { seed: 10 + k })
    typeOut($(q + ' .txt'), t + 0.08, 0.5)
    cue(t, 'voice')
    tl.to(q, { y: -50, autoAlpha: 0, duration: 0.25, ease: 'power2.in' }, t + BEAT * 2 - 0.12)
    tl.fromTo(card[id], { autoAlpha: 0, x: presented.x + 300, y: 60, z: R - 200, rotationY: -110, scale: 0.6 },
      { ...presented, autoAlpha: 1, duration: 0.75, ease: 'back.out(1.4)' }, t + BEAT)
    cue(t + BEAT, 'card', { i: k })
  })
  tl.to(card.weather, { ...leftBack, duration: 0.8, ease: 'power3.inOut' }, b(3.2))
  tl.to(card.fx, { ...rightBack, duration: 0.8, ease: 'power3.inOut' }, b(5.2))

  const props = [['#s3-p-sun', b(2.15), 30, b(3.2)], ['#s3-p-rain', b(2.35), -25, b(3.2)], ['#s3-p-coins', b(4.15), 20, b(5.2)], ['#s3-p-mail', b(6.15), -20, b(7.6)]]
  props.forEach(([el, t, rot, out], k) => {
    pop(el, t, { from: 0, rotFrom: rot * 3, rot, xFrom: rot > 0 ? -120 : 120 })
    cue(t, 'pop', { i: 6 + k })
    tl.to(el, { scale: 0, autoAlpha: 0, duration: 0.35, ease: 'back.in(2)' }, out)
  })

  tl.to('#s3-head', { x: -900, duration: 0.6, ease: 'power3.in' }, b(7))

  // The ring starts 0.15 s early, so that the cards settle on the downbeat.
  const t0 = b(8) - 0.15
  tl.to(ring, { rotationX: -10, duration: 1.2, ease: 'power2.inOut' }, t0)
  for (const id of ['weather', 'fx', 'mail-draft']) tl.to(card[id], { ...ringPose(id), duration: 0.9, ease: 'power3.inOut' }, t0)
  ;['todo', 'news', 'timer', 'map', 'calendar'].forEach((id, k) => {
    const p = ringPose(id)
    tl.fromTo(card[id], { ...p, autoAlpha: 0, y: 900, rotationX: -40 }, { ...p, autoAlpha: 1, rotationX: 0, duration: 0.85, ease: 'back.out(1.2)' }, t0 + 0.1 + k * 0.07)
    cue(t0 + 0.1 + k * 0.07, 'deal', { i: k })
  })
  tl.to(ring, { rotationY: -115, duration: b(11.35) - t0, ease: 'power1.inOut' }, t0)

  pop($$('#s3-chips .pill'), b(8.5), { from: 0.3, stagger: 0.09, yFrom: -30 })
  cue(b(8.5), 'chip', { n: 8, dur: 0.09 * 7 })

  // The cards scatter outwards rather than towards the camera, where they crowded the window of scene 4 as
  // it came in.
  const r = rng(4)
  order.forEach((id) => {
    const p = ringPose(id)
    tl.to(card[id], { x: p.x * 2.8, z: p.z * 2.2, y: (r() - 0.5) * 900, rotationX: (r() - 0.5) * 60, autoAlpha: 0, duration: 0.6, ease: 'power2.in' }, b(11.35))
  })
  tl.to(ring, { rotationY: -165, duration: 0.6, ease: 'power2.in' }, b(11.35))
  tl.to('#s3-chips', { y: -160, autoAlpha: 0, duration: 0.5, ease: 'power3.in' }, b(11.7))
  tl.to(cam, { s: 1.08, duration: b(12.6) - b(8), ease: 'power1.in' }, b(8))
  cue(b(11.35), 'whoosh')
})
