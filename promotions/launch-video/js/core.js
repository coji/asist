// Shared timeline, beat grid and helpers. Every scene file adds its tweens to `tl`; render.mjs seeks
// it frame by frame, so everything on screen must be a function of the timeline time alone.
gsap.registerPlugin(SplitText, DrawSVGPlugin, MotionPathPlugin)

const $ = (s, root = document) => root.querySelector(s)
const $$ = (s, root = document) => [...root.querySelectorAll(s)]
const W = 1920
const H = 1080

// The music runs at 106 BPM with its first beat at 0.131 s, and bars start on beat 3 after a three-beat
// pickup. Measured from assets/bgm/musicbox.mp3 with tools/beats.py and tools/downbeat.py on 2026-09-26.
const BEAT = 0.56605
const B = (n) => 0.1309 + n * BEAT

/**
 * The music skips 16 beats at beat 35 of the video, from the bar of beat 35 to the bar of beat 51, which
 * have the same harmony (chroma similarity 0.99 before and 0.95 after). audio.py makes the cut, reading it
 * from cues.json. The beat grid of the video runs on through the cut, so B(n) needs no change.
 */
const MUSIC = { splice: 35, skip: 16 }
/**
 * The time in the video of a time measured in the music after the cut. audio.py aligns the cut on the
 * note onsets on both sides, which lie 5 ms further apart than 16 beats of the grid.
 */
const M = (t) => t - MUSIC.skip * BEAT

const tl = gsap.timeline({ paused: true, defaults: { ease: 'power3.out' } })
const cues = []
/** A sound cue for audio.py: `type` names what happens on screen, not the sound. */
const cue = (t, type, extra = {}) => cues.push({ t: Math.round(t * 1000) / 1000, type, ...extra })

// Hooks run after every seek with the time, in the order they were added. Canvas effects and the
// camera read their state here, so a seek backwards gives the same picture as playing forwards.
const hooks = []
const onFrame = (fn) => hooks.push(fn)

// Scenes are built once the fonts and images are ready, because SplitText and the layout
// measurements need the final glyphs.
const builders = []
const scene = (fn) => builders.push(fn)

/** A small seeded generator (mulberry32), so particles land in the same places on every render. */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const clamp01 = (x) => Math.min(1, Math.max(0, x))

/** Shows a scene from t0 until t1. Hidden scenes cost nothing to draw. */
function show(el, t0, t1) {
  // A set at time 0 is not rendered by seek(0), so a scene that starts at 0 is made visible at once.
  if (t0 <= 0) gsap.set(el, { autoAlpha: 1 })
  else {
    gsap.set(el, { autoAlpha: 0 })
    tl.set(el, { autoAlpha: 1 }, t0)
  }
  if (t1 !== undefined) tl.set(el, { autoAlpha: 0 }, t1)
}

/**
 * Pops an element in. With squash (the default) the width and the height spring back on slightly
 * different elastic curves, which reads as a squash and stretch. The transform origin sets where it
 * grows from.
 */
function pop(el, t, o = {}) {
  const dur = o.dur ?? 0.55
  const stagger = o.stagger ?? 0
  const from = o.from ?? 0.2
  gsap.set(el, { transformOrigin: o.origin ?? '50% 50%' })
  // x and y are animated only when an offset is asked for, so elements placed by x and y keep their place.
  const move = { from: {}, to: {} }
  if (o.xFrom !== undefined) Object.assign(move.from, { x: o.xFrom }) && Object.assign(move.to, { x: 0 })
  if (o.yFrom !== undefined) Object.assign(move.from, { y: o.yFrom }) && Object.assign(move.to, { y: 0 })
  tl.fromTo(el, { autoAlpha: 0, rotation: o.rotFrom ?? o.rot ?? 0, ...move.from },
    { autoAlpha: 1, rotation: o.rot ?? 0, ...move.to, duration: dur, ease: o.ease ?? 'back.out(2)', stagger }, t)
  if (o.squash === false) {
    tl.fromTo(el, { scale: from }, { scale: 1, duration: dur, ease: 'back.out(2.2)', stagger }, t)
  } else {
    tl.fromTo(el, { scaleX: from }, { scaleX: 1, duration: dur * 1.5, ease: 'elastic.out(1.1, 0.42)', stagger }, t)
    tl.fromTo(el, { scaleY: from }, { scaleY: 1, duration: dur * 1.5, ease: 'elastic.out(1.3, 0.36)', stagger }, t + 0.035)
  }
  return el
}

function rise(el, t, o = {}) {
  return tl.fromTo(el, { autoAlpha: 0, y: o.y ?? 40 }, { autoAlpha: 1, y: 0, duration: o.dur ?? 0.7, ease: o.ease ?? 'expo.out', stagger: o.stagger ?? 0 }, t)
}

/** Splits an element into characters, keeping the spaces that the Latin words in Japanese lines need. */
function chars(el) {
  return new SplitText(el, { type: 'chars', charsClass: 'ch', reduceWhiteSpace: false }).chars
}

/**
 * Entrances for split characters. 'pop' springs each one up from below with a tilt; 'mask' raises it
 * from behind the bottom edge of its line, which the parent (.mask) clips.
 */
function kinetic(list, t, style = 'pop', o = {}) {
  const stagger = o.stagger ?? 0.035
  if (style === 'pop') {
    tl.fromTo(list, { autoAlpha: 0, y: o.y ?? 70, scale: 0.4, rotation: (i) => (i % 2 ? 14 : -14) },
      { autoAlpha: 1, y: 0, scale: 1, rotation: 0, duration: o.dur ?? 0.6, ease: 'back.out(2.3)', stagger }, t)
  } else if (style === 'mask') {
    tl.fromTo(list, { yPercent: 110 }, { yPercent: 0, duration: o.dur ?? 0.75, ease: 'expo.out', stagger }, t)
  }
  return list
}

function typeOut(el, t, dur) {
  const list = chars(el)
  gsap.set(list, { opacity: 0 })
  tl.to(list, { opacity: 1, duration: 0.01, stagger: dur / list.length }, t)
  return list
}

/** Draws an SVG path in. An empty round-capped stroke still shows a dot, so the path stays hidden until t. */
function draw(path, t, dur = 0.5, ease = 'power2.inOut') {
  gsap.set(path, { visibility: 'hidden' })
  tl.set(path, { visibility: 'visible' }, t)
  return tl.fromTo(path, { drawSVG: '0%' }, { drawSVG: '100%', duration: dur, ease }, t)
}

const SVGNS = 'http://www.w3.org/2000/svg'
function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(SVGNS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  if (parent) parent.appendChild(el)
  return el
}

/** A full-stage SVG overlay inside `parent`, for rings, sparks and hand-drawn lines. */
function overlay(parent, z = 50) {
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'overlay' }, parent)
  svg.style.zIndex = z
  return svg
}

/**
 * Keeps an element hidden outside [t0, t1]. The start state of a fromTo is drawn as soon as the tween is
 * made, and a zero-length round-capped stroke still draws a dot, so short effects are gated like this.
 */
function gate(el, t0, t1) {
  gsap.set(el, { visibility: 'hidden' })
  tl.set(el, { visibility: 'visible' }, t0)
  tl.set(el, { visibility: 'hidden' }, t1)
}

/** A ring that expands and fades, with short spark lines around it. */
function burst(svg, x, y, t, o = {}) {
  const color = o.color ?? '#3f6fe0'
  const r = o.r ?? 90
  const dur = o.dur ?? 0.6
  const ring = svgEl('circle', { cx: x, cy: y, r, fill: 'none', stroke: color, 'stroke-width': o.width ?? 6 }, svg)
  gate(ring, t, t + dur)
  tl.fromTo(ring, { scale: 0.2, opacity: 1, attr: { 'stroke-width': o.width ?? 6 } },
    { scale: 1, opacity: 0, attr: { 'stroke-width': 0.5 }, duration: dur, ease: 'expo.out', svgOrigin: `${x} ${y}`, immediateRender: false }, t)
  const n = o.sparks ?? 8
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (o.turn ?? 0.2)
    const r0 = r * 0.55
    const r1 = r * 1.25
    const line = svgEl('line', {
      x1: x + Math.cos(a) * r0, y1: y + Math.sin(a) * r0, x2: x + Math.cos(a) * r1, y2: y + Math.sin(a) * r1,
      stroke: o.spark ?? color, 'stroke-width': o.sparkWidth ?? 6, 'stroke-linecap': 'round',
    }, svg)
    gate(line, t + 0.05, t + 0.56)
    tl.fromTo(line, { drawSVG: '0% 0%' }, { drawSVG: '60% 100%', duration: 0.32, ease: 'power2.out', immediateRender: false }, t + 0.04)
    tl.to(line, { drawSVG: '100% 100%', duration: 0.26, ease: 'power2.in' }, t + 0.3)
  }
  return ring
}

/** An expanding ring alone, for pulses. */
function pulseRing(svg, x, y, t, o = {}) {
  const dur = o.dur ?? 1.1
  const ring = svgEl('circle', { cx: x, cy: y, r: o.r ?? 120, fill: 'none', stroke: o.color ?? '#7aa0ff', 'stroke-width': o.width ?? 4 }, svg)
  gate(ring, t, t + dur)
  tl.fromTo(ring, { scale: o.from ?? 0.5, opacity: o.opacity ?? 0.8 }, { scale: o.to ?? 1.6, opacity: 0, duration: dur, ease: 'power2.out', svgOrigin: `${x} ${y}`, immediateRender: false }, t)
  return ring
}

/**
 * Makes an element bob gently between t0 and t1. It is a `to` tween, so it starts from wherever the
 * earlier tweens of the element left it and does not override their starting state.
 */
function bob(el, t0, t1, o = {}) {
  const period = o.period ?? BEAT * 2
  const reps = Math.max(1, Math.round((t1 - t0) / period))
  tl.to(el, { y: `+=${o.amp ?? -12}`, duration: period / 2, ease: 'sine.inOut', yoyo: true, repeat: reps * 2 - 1 }, t0)
}

/** A canvas layer in `parent` that is cleared and redrawn on every frame by the draw functions added to it. */
function canvasLayer(parent, z = 40) {
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  c.className = 'layer-canvas'
  c.style.zIndex = z
  parent.appendChild(c)
  const ctx = c.getContext('2d')
  const draws = []
  onFrame((t) => {
    ctx.clearRect(0, 0, W, H)
    for (const d of draws) d(ctx, t)
  })
  return { ctx, add: (fn) => draws.push(fn), el: c }
}

/**
 * Confetti from (x, y) at t0, drawn on a canvas layer. The paths are closed-form (gravity with linear
 * drag), so any frame can be drawn without stepping through the ones before it.
 */
function confetti(layer, x, y, t0, o = {}) {
  const r = rng(o.seed ?? 1)
  const colors = o.colors ?? ['#3f6fe0', '#7aa0ff', '#b9a8f5', '#ffd66b', '#8fd6b4', '#ff9d7a', '#ffffff']
  const n = o.n ?? 90
  const life = o.life ?? 2.2
  const g = o.gravity ?? 1400
  const k = o.drag ?? 2.2
  const ps = Array.from({ length: n }, () => {
    const a = (o.angle ?? -Math.PI / 2) + (r() - 0.5) * (o.spread ?? Math.PI * 1.1)
    const v = (o.power ?? 1500) * (0.45 + r() * 0.75)
    return {
      vx: Math.cos(a) * v, vy: Math.sin(a) * v, c: colors[Math.floor(r() * colors.length)],
      w: 10 + r() * 14, h: 6 + r() * 8, spin: (r() - 0.5) * 18, flip: 4 + r() * 10, ph: r() * 6.28,
      shape: r() < 0.3 ? 'dot' : 'rect', delay: r() * 0.05,
    }
  })
  layer.add((ctx, t) => {
    const T = t - t0
    if (T < 0 || T > life) return
    for (const p of ps) {
      const s = T - p.delay
      if (s < 0) continue
      const e = 1 - Math.exp(-k * s)
      const px = x + (p.vx / k) * e
      const py = y + (g / k) * s + ((p.vy - g / k) / k) * e
      const fade = clamp01((life - T) / 0.5)
      ctx.save()
      ctx.globalAlpha = fade
      ctx.translate(px, py)
      ctx.rotate(p.ph + p.spin * s)
      ctx.fillStyle = p.c
      if (p.shape === 'dot') {
        ctx.beginPath()
        ctx.arc(0, 0, p.h * 0.7, 0, Math.PI * 2)
        ctx.fill()
      } else {
        const sy = Math.cos(p.ph + p.flip * s)
        ctx.fillRect(-p.w / 2, (-p.h / 2) * sy, p.w, p.h * sy)
      }
      ctx.restore()
    }
  })
}

/** Slow paper confetti that falls from above the screen and sways, starting over a few seconds from t0. */
function confettiRain(layer, t0, t1, o = {}) {
  const r = rng(o.seed ?? 9)
  const colors = o.colors ?? ['#3f6fe0', '#7aa0ff', '#b9a8f5', '#ffd66b', '#8fd6b4', '#ff9d7a']
  const ps = Array.from({ length: o.n ?? 70 }, () => ({
    x: r() * W, start: t0 + r() * (o.spawn ?? 2.6), v: 90 + r() * 110, sway: 18 + r() * 40, f: 1 + r() * 2, ph: r() * 6.28,
    w: 12 + r() * 12, h: 7 + r() * 7, c: colors[Math.floor(r() * colors.length)], spin: (r() - 0.5) * 5, flip: 3 + r() * 6,
  }))
  layer.add((ctx, t) => {
    if (t < t0 || t > t1) return
    for (const p of ps) {
      const s = t - p.start
      if (s < 0) continue
      const y = -30 + p.v * s
      if (y > H + 30) continue
      ctx.save()
      ctx.globalAlpha = Math.min(1, s / 0.3) * 0.92
      ctx.translate(p.x + p.sway * Math.sin(p.f * s + p.ph), y)
      ctx.rotate(p.ph + p.spin * s)
      const sy = Math.cos(p.ph + p.flip * s)
      ctx.fillStyle = p.c
      ctx.fillRect(-p.w / 2, (-p.h / 2) * sy, p.w, p.h * sy)
      ctx.restore()
    }
  })
}

/** Four-pointed twinkles scattered in a box, each blinking on its own phase, between t0 and t1. */
function twinkles(layer, box, t0, t1, o = {}) {
  const r = rng(o.seed ?? 7)
  const n = o.n ?? 24
  const color = o.color ?? '#ffffff'
  const stars = Array.from({ length: n }, () => ({
    x: box.x + r() * box.w, y: box.y + r() * box.h, s: (o.size ?? 14) * (0.4 + r() * 0.9),
    ph: r(), speed: 0.6 + r() * 1.2, delay: r() * (o.spreadIn ?? 0.6),
  }))
  layer.add((ctx, t) => {
    if (t < t0 || t > t1 + 0.4) return
    const out = clamp01((t1 + 0.4 - t) / 0.4)
    ctx.fillStyle = color
    for (const s of stars) {
      const a = clamp01((t - t0 - s.delay) / 0.3)
      if (a <= 0) continue
      const blink = 0.35 + 0.65 * Math.pow(Math.abs(Math.sin((t * s.speed + s.ph) * Math.PI)), 2)
      const k = s.s * blink * a * out
      ctx.globalAlpha = Math.min(1, blink * a * out)
      ctx.beginPath()
      ctx.moveTo(s.x, s.y - k)
      ctx.quadraticCurveTo(s.x, s.y, s.x + k, s.y)
      ctx.quadraticCurveTo(s.x, s.y, s.x, s.y + k)
      ctx.quadraticCurveTo(s.x, s.y, s.x - k, s.y)
      ctx.quadraticCurveTo(s.x, s.y, s.x, s.y - k)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  })
}

/**
 * A 2.5D camera for a scene: layers marked data-depth move by depth times the camera offset, so far
 * layers drift less than near ones. Tween the returned state on `tl`; it is applied after each seek.
 */
function camera(scene, o = {}) {
  const layers = $$('[data-depth]', scene).map((el) => ({ el, d: parseFloat(el.dataset.depth) }))
  const cam = { x: 0, y: 0, s: 1, r: 0, ox: o.ox ?? W / 2, oy: o.oy ?? H / 2 }
  onFrame(() => {
    for (const { el, d } of layers) {
      const s = 1 + (cam.s - 1) * d
      el.style.transformOrigin = `${cam.ox}px ${cam.oy}px`
      el.style.transform = `translate3d(${cam.x * d}px, ${cam.y * d}px, 0) rotate(${cam.r * d}deg) scale(${s})`
    }
  })
  return cam
}

/** A short vertical bump of the camera on an impact, such as something landing on a downbeat. */
function bump(cam, t, amp = 7) {
  tl.to(cam, { keyframes: [
    { y: amp, duration: 0.05, ease: 'power2.out' },
    { y: -amp * 0.5, duration: 0.09, ease: 'sine.inOut' },
    { y: 0, duration: 0.14, ease: 'sine.out' },
  ] }, t)
}

/**
 * Moves the camera's zoom origin at time t without a jump. `now` is the camera state at that time,
 * which the caller knows from its own tweens; the offset is corrected by (s - 1) times the move.
 */
function refocus(cam, t, ox, oy, now) {
  tl.set(cam, { ox, oy, x: now.x + (now.s - 1) * (ox - now.ox), y: now.y + (now.s - 1) * (oy - now.oy) }, t)
}

/**
 * Reveals an element with a wavy edge that runs down from the top ('down') or up from the bottom ('up')
 * between t0 and t1. The edge is a polygon clip-path recomputed on every frame.
 */
function waveWipe(el, t0, t1, dir = 'down', o = {}) {
  const st = { p: 0 }
  tl.to(st, { p: 1, duration: t1 - t0, ease: o.ease ?? 'power2.inOut' }, t0)
  const A = o.amp ?? 28
  const len = o.len ?? 560
  const span = H + 2 * A + 20
  onFrame((t) => {
    if (st.p >= 1) {
      el.style.clipPath = 'none'
      return
    }
    const edge = dir === 'down' ? -A - 10 + st.p * span : H + A + 10 - st.p * span
    const pts = []
    for (let x = W; x >= 0; x -= 40) pts.push(`${x}px ${(edge + A * Math.sin((x / len) * Math.PI * 2 + t * 2.4)).toFixed(1)}px`)
    const base = dir === 'down' ? `0px 0px, ${W}px 0px` : `0px ${H}px, ${W}px ${H}px`
    el.style.clipPath = `polygon(${base}, ${pts.join(', ')})`
  })
}

/** Voice bars inside an element: they move while someone speaks, between t0 and t1. */
function voiceBars(el, t0, t1, o = {}) {
  const bars = $$('i', el)
  const r = rng(o.seed ?? 3)
  const ph = bars.map(() => [r() * 6.28, 7 + r() * 6, r() * 6.28, 11 + r() * 7])
  const rest = [0.34, 0.62, 0.92, 0.62, 0.34]
  onFrame((t) => {
    const on = t >= t0 && t <= t1 ? Math.min(1, (t - t0) / 0.1, (t1 - t) / 0.15) : 0
    bars.forEach((b, i) => {
      const [p1, f1, p2, f2] = ph[i]
      const v = 0.5 + 0.3 * Math.sin(t * f1 + p1) + 0.2 * Math.sin(t * f2 + p2)
      const r = rest[i % rest.length]
      b.style.transform = `scaleY(${(r + on * (v - r)).toFixed(3)})`
    })
  })
}
