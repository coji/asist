import { useEffect, useRef } from 'react'
import { speechPlayer } from '@/voice/SpeechPlayer'
import { voiceController } from '@/voice/VoiceController'
import { liveVoice } from '@/voice/LiveVoice'
import { useTurnStore, type Phase } from '@/state/stores'
import type { NodKind } from '@shared/nod'
import { tokenRgb } from '@/themes'
import orbImage from '@/assets/holo/orb.png'
import { hslCss, mixHsl, rgbToHsl, type Hsl } from './orb-colors'

/**
 * The orb in the center. An image of a glass sphere forms its core, and a canvas lays a waveform,
 * orbits and points of light over it. The waveform moves with the phase and with the microphone or
 * TTS level, and its colours follow the phase as well, from the theme's --orb-* tokens.
 */

const MODES: Record<Phase, { energy: number; ring: string }> = {
  idle: { energy: 0.16, ring: 'var(--color-holo-dim)' },
  listen: { energy: 0.48, ring: 'var(--color-holo-cyan)' },
  think: { energy: 0.5, ring: 'var(--color-holo-violet)' },
  speak: { energy: 0.9, ring: 'var(--color-holo-peach)' }
}
const BARS = 144

/**
 * The colours of the theme on screen: the two ends the waveform sweeps between in each phase, the orbits and
 * the points of light on them.
 */
interface OrbPalette {
  bars: Record<Phase, [Hsl, Hsl]>
  orbit: [number, number, number]
  dots: [string, string]
}

function readPalette(): OrbPalette {
  const ends = (from: string, to: string): [Hsl, Hsl] => [rgbToHsl(tokenRgb(from)), rgbToHsl(tokenRgb(to))]
  const solid = (token: string): string => `rgb(${tokenRgb(token).join(' ')})`
  return {
    bars: {
      idle: ends('--orb-idle-from', '--orb-idle-to'),
      listen: ends('--orb-listen-from', '--orb-listen-to'),
      think: ends('--orb-think-from', '--orb-think-to'),
      speak: ends('--orb-speak-from', '--orb-speak-to')
    },
    orbit: tokenRgb('--orb-orbit'),
    dots: [solid('--orb-dot-1'), solid('--orb-dot-2')]
  }
}

let micLevel = 0
voiceController.events.on('level', (level) => (micLevel = level))
liveVoice.events.on('level', (level) => (micLevel = level))

/** A nod, where the sphere dips a little while listening and comes back: once for short, twice for long. */
let nodStartedAt = -Infinity
let nodKind: NodKind = 'short'
voiceController.events.on('nod', (kind) => {
  nodKind = kind
  nodStartedAt = performance.now()
})
const NOD_DIP_MS = 320
const NOD_DEPTH: Record<NodKind, number> = { short: 0.025, long: 0.04 }

/** The vertical offset for the time since the nod began, as a fraction of the whole orb, positive downwards. */
function nodOffset(elapsedMs: number, kind: NodKind): number {
  const dips = kind === 'long' ? 2 : 1
  const total = NOD_DIP_MS * dips
  if (elapsedMs < 0 || elapsedMs >= total) return 0
  const decay = 1 - 0.3 * Math.floor(elapsedMs / NOD_DIP_MS)
  return NOD_DEPTH[kind] * decay * Math.abs(Math.sin((Math.PI * elapsedMs) / NOD_DIP_MS))
}

/** The strength of the motion, taken from the TTS output level while speaking and from the microphone while listening. */
function liveEnergy(phase: Phase, t: number): number {
  switch (phase) {
    case 'speak':
      return 0.35 + speechPlayer.level() * 1.1
    case 'listen':
      return 0.35 + micLevel * 1.2
    case 'think':
      return 0.6 + 0.25 * Math.sin(t * 6)
    default:
      return 0.8
  }
}

export function Orb({ size = 240 }: { size?: number }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const coreRef = useRef<HTMLImageElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const phase = useTurnStore((s) => s.phase)
  const phaseRef = useRef<Phase>(phase)
  phaseRef.current = phase

  useEffect(() => {
    if (phase !== 'idle') spawnRing(hostRef.current, MODES[phase].ring)
  }, [phase])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const S = Math.round(size * Math.min(devicePixelRatio || 1, 2))
    canvas.width = S
    canvas.height = S
    const c = S / 2

    let palette = readPalette()
    let bars = palette.bars.idle
    // The rest of the UI switches theme at once, so the waveform jumps too rather than fading from the
    // old theme's colours.
    const theme = new MutationObserver(() => {
      palette = readPalette()
      bars = palette.bars[phaseRef.current]
    })
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    let energy = MODES.idle.energy
    let lastT = performance.now()
    let lastDraw = 0
    let lastNod = 0
    let raf = 0

    const frame = (): void => {
      const now = performance.now()
      const idle = phaseRef.current === 'idle'
      if (now - lastDraw < (idle ? 66 : 33)) {
        raf = requestAnimationFrame(frame)
        return
      }
      lastDraw = now
      const dt = Math.min((now - lastT) / 1000, 0.1)
      lastT = now
      const t = now / 1000
      const mode = MODES[phaseRef.current]
      energy += (Math.min(1, mode.energy * liveEnergy(phaseRef.current, t)) - energy) * dt * 4
      const target = palette.bars[phaseRef.current]
      bars = [mixHsl(bars[0], target[0], dt * 3), mixHsl(bars[1], target[1], dt * 3)]

      const nod = nodOffset(now - nodStartedAt, nodKind)
      if (nod !== lastNod && coreRef.current) {
        coreRef.current.style.top = `${14 + nod * 100}%`
        lastNod = nod
      }

      ctx.clearRect(0, 0, S, S)
      const inner = S * 0.354
      ctx.lineWidth = S / 270
      for (let i = 0; i < BARS; i++) {
        const a = (i / BARS) * Math.PI * 2
        const wave = (0.5 + 0.5 * Math.sin(i * 0.34 + t * 4.2) * Math.sin(i * 0.17 - t * 2.7)) * energy
        const outer = inner + S * (0.018 + wave * 0.063)
        ctx.strokeStyle = hslCss(mixHsl(bars[0], bars[1], 0.5 + 0.5 * Math.sin(a)), 0.5 + wave * 0.5)
        ctx.beginPath()
        ctx.moveTo(c + Math.cos(a) * inner, c + Math.sin(a) * inner)
        ctx.lineTo(c + Math.cos(a) * outer, c + Math.sin(a) * outer)
        ctx.stroke()
      }
      for (let ring = 0; ring < 3; ring++) {
        const radius = S * (0.408 + ring * 0.035)
        ctx.strokeStyle = `rgb(${palette.orbit.join(' ')} / ${0.19 - ring * 0.045})`
        ctx.lineWidth = S / 650
        ctx.beginPath()
        ctx.arc(c, c, radius, t * 0.07 + ring, t * 0.07 + ring + Math.PI * 1.65)
        ctx.stroke()
        ctx.fillStyle = palette.dots[ring % 2]
        ctx.shadowColor = ctx.fillStyle
        ctx.shadowBlur = S * 0.02
        for (let j = 0; j < 4; j++) {
          const a = j * 1.6 + t * (0.09 + ring * 0.04) + ring * 2
          ctx.beginPath()
          ctx.arc(c + Math.cos(a) * radius, c + Math.sin(a) * radius, S * 0.0026, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.shadowBlur = 0
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      theme.disconnect()
    }
  }, [size])

  return (
    <div ref={hostRef} className="orb" data-phase={phase} style={{ width: size, height: size }}>
      <img ref={coreRef} className="orb-core" src={orbImage} alt="" />
      <canvas ref={canvasRef} style={{ width: size, height: size }} />
    </div>
  )
}

function spawnRing(host: HTMLDivElement | null, color: string): void {
  if (!host) return
  const ring = document.createElement('div')
  ring.className = 'ring-pulse pointer-events-none absolute inset-0 m-auto rounded-full border-2'
  ring.style.width = '48%'
  ring.style.height = '48%'
  ring.style.borderColor = `rgb(from ${color} r g b / 0.7)`
  host.appendChild(ring)
  ring.addEventListener('animationend', () => ring.remove())
}
