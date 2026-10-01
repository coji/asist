import { useEffect, useRef } from 'react'
import { useTurnStore, type Phase } from '@/state/stores'

/** The particle field in the background. It follows the phase color faintly and shifts with the mouse for parallax. */

const PHASE_COLOR: Record<Phase, [number, number, number]> = {
  idle: [94, 120, 160],
  listen: [111, 231, 255],
  think: [157, 140, 255],
  speak: [255, 178, 122]
}

export function Starfield(): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(devicePixelRatio || 1, 2)
    let width = 0
    let height = 0
    const stars = Array.from({ length: 80 }, () => ({
      x: Math.random(),
      y: Math.random(),
      z: 0.3 + Math.random() * 0.7,
      tw: Math.random() * 7
    }))
    let mx = 0
    let my = 0
    const cur: [number, number, number] = [94, 120, 160]

    const resize = (): void => {
      width = innerWidth
      height = innerHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    }
    resize()
    addEventListener('resize', resize)
    const onMouse = (e: MouseEvent): void => {
      mx = e.clientX / width - 0.5
      my = e.clientY / height - 0.5
    }
    addEventListener('mousemove', onMouse)

    let raf = 0
    let lastT = performance.now()
    let lastDraw = 0
    let lastGlow = ''
    const frame = (): void => {
      const now = performance.now()
      // While idle the field drops to 15 fps, since background decoration does not need 60.
      if (useTurnStore.getState().phase === 'idle' && now - lastDraw < 66) {
        raf = requestAnimationFrame(frame)
        return
      }
      lastDraw = now
      const dt = Math.min((now - lastT) / 1000, 0.1)
      lastT = now
      const t = now / 1000
      const target = PHASE_COLOR[useTurnStore.getState().phase]
      for (let i = 0; i < 3; i++) cur[i] += (target[i] - cur[i]) * dt * 3

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      const [r, g, b] = cur.map((v) => v | 0)
      // The glow behind the field is the canvas's own background, painted again only when its colour or the
      // window changes, rather than filled over the whole window in every frame.
      const glow = `radial-gradient(circle ${Math.max(width, height) * 0.7}px at 50% 42%, rgba(${r},${g},${b},0.05), transparent)`
      if (glow !== lastGlow) {
        canvas.style.background = glow
        lastGlow = glow
      }
      for (const s of stars) {
        const alpha = (0.12 + 0.5 * s.z * (0.55 + 0.45 * Math.sin(t * 1.3 + s.tw * 6))) * 0.5
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`
        ctx.fillRect(s.x * width + mx * 30 * s.z, s.y * height + my * 30 * s.z, s.z < 0.6 ? 1 : 1.6, s.z < 0.6 ? 1 : 1.6)
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      removeEventListener('resize', resize)
      removeEventListener('mousemove', onMouse)
    }
  }, [])

  return <canvas ref={ref} className="starfield" aria-hidden />
}
