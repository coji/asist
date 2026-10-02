// Scene 5, beat 35 to 47: the Dock of the app, blown up. Each mini app gets a handwritten label, then
// "カレンダーで来週を開いて" opens the real calendar out of its icon, and a tap on the Agent icon
// opens scene 6 out of that icon.
scene(() => {
  const S = 35
  const b = (k) => B(S + k)
  const s = $('#s5')
  const cam = camera(s)
  const fx = overlay($('#s5-world'), 30)
  show(s, b(-0.1), b(12.4))
  tl.fromTo(s, { opacity: 0 }, { opacity: 1, duration: 0.18, ease: 'none' }, b(-0.1))

  gsap.set('#s5-dock', { xPercent: -50 })
  const stage = $('#stage').getBoundingClientRect()
  const centre = (id) => {
    const r = $(id).getBoundingClientRect()
    return { x: r.left - stage.left + r.width / 2, y: r.top - stage.top + r.height / 2 }
  }
  const DROP = 240
  // The arrows are measured before the Dock is scaled or moved. Each head is turned to the direction in
  // which its curve arrives, because a separate head at a fixed angle came loose from a bent line.
  const arrows = $$('#s5-dock .lbl').map((lbl) => {
    const a = $('.lbl-in', lbl).getBoundingClientRect()
    const icon = lbl.parentElement.getBoundingClientRect()
    const x0 = a.left - stage.left + a.width / 2 + 4
    const y0 = a.bottom - stage.top + 6
    const x1 = icon.left - stage.left + icon.width / 2 - 4
    const y1 = icon.top - stage.top - 4
    const len = y1 - y0
    // A short arrow bends less, or it reads as a hook.
    const bend = Math.min(12, len * 0.12)
    const c2 = { x: x1 - bend * 0.75, y: y1 - len * 0.42 }
    const g = svgEl('g', {}, fx)
    const style = { fill: 'none', stroke: '#8a90a6', 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
    const line = svgEl('path', { ...style, d: `M${x0},${y0} C${x0 + bend},${y0 + len * 0.45} ${c2.x},${c2.y} ${x1},${y1}` }, g)
    const ang = Math.atan2(y1 - c2.y, x1 - c2.x)
    const hl = 15
    const p1 = `${(x1 - hl * Math.cos(ang - 0.55)).toFixed(1)},${(y1 - hl * Math.sin(ang - 0.55)).toFixed(1)}`
    const p2 = `${(x1 - hl * Math.cos(ang + 0.55)).toFixed(1)},${(y1 - hl * Math.sin(ang + 0.55)).toFixed(1)}`
    const head = svgEl('path', { ...style, d: `M${p1} L${x1},${y1} L${p2}` }, g)
    return { g, line, head }
  })
  const cal = centre('#di-calendar')
  const agent = centre('#di-agent')
  cal.y += DROP
  agent.y += DROP
  window.__agentIcon = agent

  // The zoom of scene 4 lands a little larger than this Dock, which settles to its own size.
  tl.fromTo('#s5-dock', { scale: 1.07 }, { scale: 1, duration: 0.8, ease: 'power3.out' }, b(0))
  tl.fromTo('#s5-mk', { '--mk': 0 }, { '--mk': 1, duration: 0.5, ease: 'power2.inOut' }, b(0.6))
  kinetic(chars($('#s5-head .h-l .marker')), b(0), 'pop', { stagger: 0.05, y: 60 })
  rise('#s5-h3', b(0.8), { y: 30 })
  cue(b(0), 'type', { n: 5, dur: 0.25 })

  $$('#s5-dock .lbl').forEach((el, i) => {
    // One label on each eighth note, since audio.py gives each label one note of a kalimba run.
    const t = b(1.5) + i * (BEAT / 2)
    tl.fromTo(el, { autoAlpha: 0, y: 24, scale: 0.6, transformOrigin: '0% 100%' }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.45, ease: 'back.out(2.6)' }, t)
    draw(arrows[i].line, t + 0.08, 0.26, 'power2.in')
    draw(arrows[i].head, t + 0.32, 0.12, 'power1.out')
    cue(t, 'label', { i })
  })
  tl.to($$('#s5-dock .di b'), { scale: 1.35, duration: 0.12, ease: 'power2.out', yoyo: true, repeat: 1, stagger: 0.07 }, b(4.5))
  cue(b(4.5), 'badge')

  tl.to(['#s5-head', ...$$('#s5-dock .lbl'), ...arrows.map((a) => a.g)], { autoAlpha: 0, y: -30, duration: 0.3, ease: 'power2.in' }, b(5.2))
  tl.to('#s5-dock', { y: DROP, duration: 0.6, ease: 'power3.inOut' }, b(5.2))

  gsap.set('#s5-ask', { xPercent: -50 })
  pop('#s5-ask', b(5.5), { from: 0.3, origin: '10% 110%', rotFrom: -6, rot: -1.5 })
  voiceBars($('#s5-ask .bars'), b(5.5) + 0.05, b(6.9), { seed: 21 })
  typeOut($('#s5-ask .txt'), b(5.5) + 0.08, 0.75)
  cue(b(5.5), 'voice')

  const tap = (id, t) => {
    tl.to(id, { y: -40, scale: 1.15, duration: 0.16, ease: 'power2.out', yoyo: true, repeat: 1 }, t)
    cue(t, 'tap')
  }
  tap('#di-calendar', b(6.9))
  const win = { x: 456 + 504, y: 180 + 333 }
  tl.fromTo('#s5-cal', { autoAlpha: 0, x: cal.x - win.x, y: cal.y - win.y, scale: 0.08, rotation: -6 },
    { autoAlpha: 1, x: 0, y: 0, scale: 1, rotation: 0, duration: 0.7, ease: 'back.out(1.3)' }, b(7.2))
  cue(b(7.2), 'open')
  tl.to('#s5-cal', { x: cal.x - win.x, y: cal.y - win.y, scale: 0.05, autoAlpha: 0, duration: 0.4, ease: 'back.in(1.4)' }, b(10.5))
  tl.to('#s5-ask', { autoAlpha: 0, y: -30, duration: 0.3, ease: 'power2.in' }, b(10.4))
  cue(b(10.5), 'close')

  tap('#di-agent', b(11))
  burst(fx, agent.x, agent.y, b(11.1), { r: 110, color: '#7aa0ff' })
  tl.to(cam, { s: 1.12, duration: b(12.4) - b(11.2), ease: 'power2.in' }, b(11.2))
  cam.ox = agent.x
  cam.oy = agent.y
})
