// Scene 7, beat 59 to 67: night falls as a wavy curtain, the moon rises, the clock turns to 0:00 and the
// robot writes its diary on a cloud while the entry types itself out, the pencil following the text.
scene(() => {
  const S = 59
  const b = (k) => B(S + k)
  const s = $('#s7')
  const cam = camera(s)
  const sky = canvasLayer($('#s7-sky'), 1)
  show(s, b(-0.6), b(8.5))
  waveWipe(s, b(-0.5), b(0.4), 'down', { amp: 34 })
  cue(b(-0.5), 'night')

  twinkles(sky, { x: 0, y: 0, w: W, h: 760 }, b(0), b(8.5), { n: 80, size: 11, color: '#fff6d8', seed: 12, spreadIn: 1.2 })
  tl.fromTo('#s7-moon', { autoAlpha: 0, y: 480, rotation: -30 }, { autoAlpha: 1, y: 0, rotation: 0, duration: 1.3, ease: 'expo.out' }, b(0))
  tl.to('#s7-moon', { rotation: 6, duration: BEAT * 4, ease: 'sine.inOut', yoyo: true, repeat: 1 }, b(2))
  $$('.s7-star').forEach((el, i) => {
    pop(el, b(0.6) + i * 0.18, { from: 0, rotFrom: -90, rot: 0 })
    tl.to(el, { scale: 1.25, duration: BEAT, ease: 'sine.inOut', yoyo: true, repeat: 5 }, b(2) + i * 0.3)
  })

  kinetic(chars($('#s7-h')), b(0.5), 'pop', { stagger: 0.07, y: 70 })
  cue(b(0.5), 'type', { n: 2, dur: 0.14 })
  pop('#s7-clock', b(0.75), { from: 0.3, origin: '0% 50%' })
  tl.fromTo('#s7-t0', { yPercent: 0 }, { yPercent: -110, duration: 0.35, ease: 'back.in(1.6)' }, b(1.5))
  tl.fromTo('#s7-t1', { yPercent: 110 }, { yPercent: 0, duration: 0.45, ease: 'back.out(2)' }, b(1.5) + 0.2)
  cue(b(1.5) + 0.2, 'clock')
  rise('#s7-h3', b(1), { y: 30 })

  tl.fromTo('#s7-cloud', { autoAlpha: 0, y: 320 }, { autoAlpha: 1, y: 0, duration: 1, ease: 'expo.out' }, b(1))
  tl.fromTo('#s7-robot', { autoAlpha: 0, y: 380 }, { autoAlpha: 1, y: 0, duration: 1, ease: 'back.out(1.3)' }, b(1.15))
  gsap.set('#s7-robot', { transformOrigin: '50% 90%' })
  tl.to('#s7-robot', { rotation: -3, duration: BEAT, ease: 'sine.inOut', yoyo: true, repeat: 5 }, b(2.5))
  bob('#s7-cloud', b(2.5), b(8.5), { amp: -10, period: BEAT * 2 })

  rise('#s7-diary', b(1.75), { y: 50 })
  // The pencil sound of this cue has a fixed length of about 2 s, so the entry is written in about as long.
  const t0 = b(2.25)
  const dur = b(5.65) - t0
  const list = typeOut($('#s7-body'), t0, dur)
  const pos = list.map((c) => ({ x: c.offsetLeft + c.offsetWidth, y: c.offsetTop + c.offsetHeight * 0.62 }))
  const pencil = $('#s7-pencil')
  gsap.set(pencil, { autoAlpha: 0, rotation: 180 })
  tl.to(pencil, { autoAlpha: 1, duration: 0.2 }, t0 - 0.2)
  tl.to(pencil, { autoAlpha: 0, duration: 0.3 }, t0 + dur + 0.3)
  onFrame((t) => {
    const k = Math.min(list.length - 1, Math.max(0, Math.floor(((t - t0) / dur) * list.length)))
    const p = pos[k]
    // The tip of the upturned pencil is at its lower left.
    pencil.style.left = `${p.x - 7 + Math.sin(t * 38) * 2}px`
    pencil.style.top = `${p.y - 86 + Math.cos(t * 31) * 3}px`
  })
  cue(t0, 'write', { dur })

  tl.fromTo('#s7-note', { autoAlpha: 0, scale: 0.7, rotation: -12 }, { autoAlpha: 1, scale: 1, rotation: -4, duration: 0.6, ease: 'back.out(2)' }, b(6))
  cue(b(6), 'note')
  tl.to(cam, { s: 1.04, duration: b(8.5) - b(0), ease: 'none' }, b(0))
})
