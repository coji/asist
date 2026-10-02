// Scene 6, beat 47 to 59: it opens as a circle out of the Agent icon of scene 5. A request, a stack of
// papers flying into the approval dialog, the click, the hand-off to codex or claude, and the job
// running to DONE on the downbeat of beat 55, with confetti and the robot jumping for joy.
scene(() => {
  const S = 47
  const b = (k) => B(S + k)
  const s = $('#s6')
  const cam = camera(s)
  const fx = overlay($('#s6-world'), 25)
  const confettiLayer = canvasLayer($('#s6-world'), 40)
  const icon = window.__agentIcon
  show(s, b(-0.2), b(12.5))

  gsap.set(s, { clipPath: `circle(0px at ${icon.x}px ${icon.y}px)` })
  tl.to(s, { clipPath: `circle(2300px at ${icon.x}px ${icon.y}px)`, duration: 0.6, ease: 'power3.in' }, b(-0.1))
  const edge = svgEl('circle', { cx: icon.x, cy: icon.y, r: 0, fill: 'none', stroke: '#b9a8f5', 'stroke-width': 16 }, overlay($('#stage'), 94))
  gsap.set(edge, { autoAlpha: 0 })
  tl.set(edge, { autoAlpha: 1 }, b(-0.1))
  tl.to(edge, { attr: { r: 2300 }, duration: 0.6, ease: 'power3.in' }, b(-0.1))
  tl.set(edge, { autoAlpha: 0 }, b(-0.1) + 0.6)
  cue(b(-0.1), 'whoosh')

  // Measured before any tween scales the dialog.
  const stage = $('#stage').getBoundingClientRect()
  const rectOf = (id) => {
    const r = $(id).getBoundingClientRect()
    return { x: r.left - stage.left, y: r.top - stage.top, w: r.width, h: r.height }
  }
  const go = rectOf('#s6-go')
  const dlg = rectOf('#s6-confirm')
  const cli1 = rectOf('#s6-cli1')
  const cli2 = rectOf('#s6-cli2')
  const job = rectOf('#s6-job')
  const ask = rectOf('#s6-ask')

  tl.fromTo('#s6-dio', { autoAlpha: 0, y: 80, scale: 0.94 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.9, ease: 'expo.out' }, b(0.2))
  bob('#s6-dio', b(1.8), b(12.5), { amp: -10, period: BEAT * 4 })
  kinetic(chars($('#s6-mk')), b(0.5), 'pop', { stagger: 0.05, y: 60 })
  tl.fromTo('#s6-mk', { '--mk': 0 }, { '--mk': 1, duration: 0.5, ease: 'power2.inOut' }, b(0.9))
  rise('#s6-h3', b(1), { y: 30 })
  cue(b(0.5), 'type', { n: 5, dur: 0.25 })

  pop('#s6-ask', b(1), { from: 0.3, origin: '38% 110%', rotFrom: -7, rot: -2 })
  voiceBars($('#s6-ask .bars'), b(1) + 0.05, b(2.4), { seed: 31 })
  typeOut($('#s6-ask .txt'), b(1) + 0.1, 0.7)
  cue(b(1), 'voice')

  const from = { x: ask.x + ask.w * 0.62 - 85, y: ask.y + ask.h + 30 }
  const to = { x: dlg.x + dlg.w / 2 - 85, y: dlg.y + dlg.h / 2 - 70 }
  // Explicit tweens rather than pop, whose springy scale and fade would still be running when the
  // papers vanish and would bring them back.
  gsap.set('#s6-p-docs', { x: from.x, y: from.y, rotation: -8 })
  tl.fromTo('#s6-p-docs', { autoAlpha: 0, scale: 0 }, { autoAlpha: 1, scale: 1, duration: 0.3, ease: 'back.out(2.5)' }, b(2.4))
  tl.to('#s6-p-docs', { motionPath: { path: [{ x: from.x, y: from.y }, { x: (from.x + to.x) / 2, y: 90 }, { x: to.x, y: to.y }], curviness: 1.3 },
    rotation: 20, duration: b(3.5) - b(2.85), ease: 'power2.in' }, b(2.85))
  tl.to('#s6-p-docs', { scale: 0.2, autoAlpha: 0, duration: 0.12, ease: 'power1.in' }, b(3.5) - 0.06)
  cue(b(2.4), 'pop', { i: 13 })
  cue(b(2.85), 'fly')
  pop('#s6-confirm', b(3.5), { from: 0.5 })
  burst(fx, dlg.x + dlg.w / 2, dlg.y + dlg.h / 2, b(3.5), { r: 330, color: '#b9a8f5', sparks: 12 })
  cue(b(3.5), 'dialog')

  const gx = go.x + go.w * 0.55
  const gy = go.y + go.h * 0.55
  gsap.set('#s6-cursor', { x: 1750, y: 1080, autoAlpha: 0 })
  tl.to('#s6-cursor', { autoAlpha: 1, duration: 0.15 }, b(4))
  tl.to('#s6-cursor', { x: gx - 10, y: gy - 8, duration: b(4.8) - b(4), ease: 'power3.inOut' }, b(4))
  tl.to(['#s6-go', '#s6-cursor'], { scale: 0.88, duration: 0.07, yoyo: true, repeat: 1, ease: 'power1.inOut' }, b(5))
  pulseRing(fx, gx, gy, b(5), { r: 60, from: 0.4, to: 2.2, color: '#3f6fe0', width: 6, dur: 0.6 })
  tl.to('#s6-cursor', { autoAlpha: 0, duration: 0.3 }, b(5.75))
  cue(b(4), 'cursor', { dur: b(4.8) - b(4) })
  cue(b(5), 'click')

  const arrow = (c) => {
    const x0 = dlg.x + dlg.w + 8
    const y0 = dlg.y + dlg.h * 0.42
    const x1 = c.x - 12
    const y1 = c.y + c.h / 2
    return svgEl('path', { d: `M${x0},${y0} C${x0 + 60},${y0} ${x1 - 60},${y1} ${x1},${y1}`, fill: 'none', stroke: '#8a90a6', 'stroke-width': 5, 'stroke-linecap': 'round', 'stroke-dasharray': '2 12' }, fx)
  }
  const a1 = arrow(cli1)
  const a2 = arrow(cli2)
  gsap.set([a1, a2], { autoAlpha: 0 })
  tl.set([a1, a2], { autoAlpha: 1 }, b(5.4))
  tl.fromTo([a1, a2], { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: 0.35, ease: 'power2.out', stagger: 0.12 }, b(5.4))
  // Dots at both ends make the dotted lines read as connectors rather than loose dots.
  const node = (x, y, r, t) => {
    const c = svgEl('circle', { cx: x, cy: y, r, fill: '#8a90a6' }, fx)
    gsap.set(c, { autoAlpha: 0 })
    tl.fromTo(c, { autoAlpha: 0, scale: 0 }, { autoAlpha: 1, scale: 1, duration: 0.25, ease: 'back.out(3)', svgOrigin: `${x} ${y}`, immediateRender: false }, t)
    return c
  }
  const nodes = [node(dlg.x + dlg.w + 8, dlg.y + dlg.h * 0.42, 7, b(5.4)),
    node(cli1.x - 12, cli1.y + cli1.h / 2, 5, b(5.4) + 0.3), node(cli2.x - 12, cli2.y + cli2.h / 2, 5, b(5.4) + 0.42)]
  pop('#s6-cli1', b(5.5), { from: 0.4, origin: '0% 50%' })
  pop('#s6-cli2', b(5.75), { from: 0.4, origin: '0% 50%' })
  pop('#s6-p-term', b(6), { from: 0, rotFrom: 30, rot: 8 })
  cue(b(5.5), 'cli')

  rise('#s6-job', b(6), { y: 40 })
  tl.to('#s6-fill', { scaleX: 1, duration: b(8) - b(6.25), ease: 'power1.inOut' }, b(6.25))
  cue(b(6.25), 'progress', { n: 7, dur: b(8) - b(6.25) - 0.1 })
  tl.to(['#s6-confirm', '#s6-cli1', '#s6-cli2', '#s6-p-term', a1, a2, ...nodes], { autoAlpha: 0, scale: 0.85, duration: 0.25, ease: 'power2.in' }, b(7.6))
  tl.to('#s6-job .run', { opacity: 0, duration: 0.1 }, b(8))
  pop('#s6-job .done', b(8), { from: 0.4 })
  confetti(confettiLayer, job.x + job.w - 110, job.y + 30, b(8), { seed: 5, n: 110, power: 1700, spread: Math.PI * 0.9 })
  cue(b(8), 'done')
  bump(cam, b(8), 6)

  const land = b(8) + 0.42
  tl.fromTo('#s6-robot', { autoAlpha: 0, y: 380, scaleX: 0.88, scaleY: 1.14 }, { autoAlpha: 1, y: -28, duration: 0.3, ease: 'power2.out' }, b(8) + 0.02)
  tl.to('#s6-robot', { y: 0, duration: land - b(8) - 0.32, ease: 'power2.in' }, b(8) + 0.32)
  tl.to('#s6-robot', { keyframes: [
    { scaleX: 1.12, scaleY: 0.86, duration: 0.07, ease: 'power1.out' },
    { scaleX: 1, scaleY: 1, duration: 0.45, ease: 'elastic.out(1.2, 0.4)' },
  ] }, land)
  gsap.set('#s6-robot', { transformOrigin: '50% 100%' })
  for (const k of [9.5, 10.5]) {
    tl.to('#s6-robot', { y: -26, duration: BEAT * 0.4, ease: 'power2.out', yoyo: true, repeat: 1 }, b(k) - BEAT * 0.4)
  }
  rise('#s6-note', b(8.6), { y: 24 })
  tl.to(cam, { s: 1.03, duration: b(12) - b(1), ease: 'none' }, b(1))
})
