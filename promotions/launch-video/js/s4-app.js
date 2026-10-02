// Scene 4, beat 27 to 35: the real app swings in out of the card ring, its parts are pointed out, and
// the camera dives into its Dock, which becomes the big Dock of scene 5.
scene(() => {
  const S = 27
  const b = (k) => B(S + k)
  const s = $('#s4')
  const cam = camera(s)
  const fx = overlay($('#s4-world'), 20)
  show(s, b(-0.1), b(8.25))

  // home.jpg is 2000 x 1150 and is shown 1400 wide, below the 36 px title bar of the window at (260, 175).
  const at = (X, Y) => ({ x: 260 + X * 0.7, y: 211 + Y * 0.7 })
  const orb = at(1000, 305)
  const dock = at(1000, 1080)

  tl.fromTo('#s4-win', { autoAlpha: 0, z: -1400, rotationX: 38, rotationY: -32, rotation: 9, y: 120 },
    { autoAlpha: 1, z: 0, rotationX: 0, rotationY: 0, rotation: 0, y: 0, duration: 1.25, ease: 'expo.out' }, b(0.1))
  cue(b(0.1), 'swoosh')
  tl.fromTo('#s4-gloss', { xPercent: -120 }, { xPercent: 400, duration: 0.8, ease: 'power2.inOut' }, b(1.2))

  const title = chars($('#s4-title .mask'))
  kinetic(title, b(0.6), 'mask', { stagger: 0.022 })

  for (let k = 0; k < 8; k++) pulseRing(fx, orb.x, orb.y, b(1.25) + k * BEAT / 2, { r: 110, from: 0.95, to: 1.9, color: k % 2 ? '#b9a8f5' : '#7aa0ff', width: 5, dur: 1.0 })
  pop('#s4-tag3', b(1.5), { from: 0.3, origin: '0% 50%', rotFrom: 10, rot: -3 })

  const box = (X0, Y0, X1, Y1) => {
    const a = at(X0, Y0)
    const c = at(X1, Y1)
    const r = 20
    return `M${a.x + r},${a.y} H${c.x - r} Q${c.x},${a.y} ${c.x},${a.y + r} V${c.y - r} Q${c.x},${c.y} ${c.x - r},${c.y} H${a.x + r} Q${a.x},${c.y} ${a.x},${c.y - r} V${a.y + r} Q${a.x},${a.y} ${a.x + r},${a.y} Z`
  }
  const o1 = svgEl('path', { d: box(38, 118, 500, 868), fill: 'none', stroke: '#3f6fe0', 'stroke-width': 6, 'stroke-linecap': 'round' }, fx)
  const o2 = svgEl('path', { d: box(1500, 118, 1962, 1092), fill: 'none', stroke: '#3f6fe0', 'stroke-width': 6, 'stroke-linecap': 'round' }, fx)
  draw(o1, b(2), 0.6)
  draw(o2, b(2.75), 0.6)
  pop('#s4-tag1', b(2.15), { from: 0.3, origin: '0% 100%' })
  pop('#s4-tag2', b(2.9), { from: 0.3, origin: '0% 100%' })
  cue(b(1.5), 'pop', { i: 10 })
  cue(b(2.15), 'pop', { i: 11 })
  cue(b(2.9), 'pop', { i: 12 })
  pop('#s4-note', b(3.5), { from: 0.4, rotFrom: 14, rot: 5 })
  cue(b(3.5), 'note')

  tl.to(cam, { s: 1.04, duration: b(5.8) - b(1.3), ease: 'none' }, b(1.3))
  tl.to(['#s4-title', '#s4-tag1', '#s4-tag2', '#s4-tag3', '#s4-note', o1, o2], { autoAlpha: 0, duration: 0.3, ease: 'power2.in' }, b(5.6))

  // The dive ends with the Dock's centre at y 732, where the Dock of scene 5 is centred.
  refocus(cam, b(5.9), dock.x, dock.y, { x: 0, y: 0, s: 1.04, ox: W / 2, oy: H / 2 })
  tl.to(cam, { s: 2.3, x: 0, y: 732 - dock.y, duration: b(8) - b(6), ease: 'power3.inOut' }, b(6))
  cue(b(6), 'zoom', { dur: b(8) - b(6) })
  tl.to(s, { autoAlpha: 0, duration: 0.18, ease: 'none' }, b(8) - 0.02)
})
