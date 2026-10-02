import { useEffect, useRef, useState } from 'react'
import { formatBytes, tooLargeToRead } from '@shared/files'
import { Frame } from './Frame'
import { downsampleWaveform, formatTime } from './media'
import { MediaControls, useMediaState } from './MediaControls'
import type { Viewer } from './types'
import './MediaViewer.css'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'

/**
 * Audio. The <audio> element stays hidden and the waveform together with MediaControls drives it. The
 * waveform is built by fetching the bytes, decoding them with Web Audio and drawing each bucket's peak
 * amplitude on a canvas. Decoding costs memory, so a file larger than the audio limit of WHOLE_READ_LIMIT gets a
 * flat bar and a note instead. Playback itself belongs to <audio src>, so a large file can still be listened to.
 * Pressing the waveform seeks to that position.
 */
const BUCKETS = 400

type Waveform = { state: 'loading' } | { state: 'ready'; peaks: number[] } | { state: 'skipped' } | { state: 'failed'; message: string }

function useWaveform(url: string | undefined, tooLarge: boolean): Waveform {
  const [waveform, setWaveform] = useState<Waveform>({ state: 'loading' })
  useEffect(() => {
    if (!url) return
    if (tooLarge) {
      setWaveform({ state: 'skipped' })
      return
    }
    let cancelled = false
    setWaveform({ state: 'loading' })
    void (async () => {
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const bytes = await response.arrayBuffer()
        const context = new AudioContext()
        try {
          const buffer = await context.decodeAudioData(bytes)
          const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))
          if (!cancelled) setWaveform({ state: 'ready', peaks: downsampleWaveform(channels, BUCKETS) })
        } finally {
          void context.close()
        }
      } catch (error) {
        if (!cancelled) setWaveform({ state: 'failed', message: displayError(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [url, tooLarge])
  return waveform
}

/**
 * Draws the waveform on the canvas. What has been played is brighter, and without peaks a flat line sits in the
 * middle. A canvas takes no CSS, so the colors are read from the theme's tokens on the canvas at each draw.
 */
function drawWaveform(canvas: HTMLCanvasElement, peaks: number[] | null, progress: number): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (width === 0 || height === 0) return
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, width, height)
  const style = getComputedStyle(canvas)
  const unplayed = style.getPropertyValue('--viewer-wave').trim()
  const played = style.getPropertyValue('--color-holo-cyan').trim()
  const mid = height / 2
  if (!peaks || peaks.length === 0) {
    ctx.fillStyle = unplayed
    ctx.fillRect(0, mid - 1, width, 2)
    ctx.fillStyle = played
    ctx.fillRect(0, mid - 1, width * progress, 2)
    return
  }
  const step = width / peaks.length
  const bar = Math.max(1, step * 0.7)
  const playedUntil = width * progress
  for (let i = 0; i < peaks.length; i++) {
    const x = i * step
    const h = Math.max(1, peaks[i] * (height - 4))
    ctx.fillStyle = x < playedUntil ? played : unplayed
    ctx.fillRect(x, mid - h / 2, bar, h)
  }
}

export const AudioViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const ref = useRef<HTMLAudioElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const state = useMediaState(ref)
  const waveform = useWaveform(item.url, tooLargeToRead(item))
  const [error, setError] = useState<string | null>(null)
  const progress = state.duration > 0 ? state.current / state.duration : 0
  const peaks = waveform.state === 'ready' ? waveform.peaks : null

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const draw = (): void => drawWaveform(canvas, peaks, progress)
    draw()
    const resize = new ResizeObserver(draw)
    resize.observe(canvas)
    const theme = new MutationObserver(draw)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      resize.disconnect()
      theme.disconnect()
    }
  }, [peaks, progress])

  if (!item.url || error) {
    return (
      <Frame mode={mode} size={size}>
        <p className="fv-note" data-tone="error">
          {error ?? t('files.viewer.audioFailed')}
        </p>
      </Frame>
    )
  }
  const reason =
    waveform.state === 'skipped'
      ? t('files.viewer.waveformTooLarge', { size: formatBytes(item.sizeBytes) })
      : waveform.state === 'failed'
        ? t('files.viewer.waveformFailed', { message: waveform.message })
        : null
  return (
    <Frame mode={mode} size={size} className="fv-media">
      <audio ref={ref} src={item.url} preload="metadata" onError={() => setError(t('files.viewer.audioUnplayable'))} />
      <canvas
        ref={canvasRef}
        className="fv-media-wave"
        role="img"
        aria-label={t('files.viewer.waveform')}
        data-state={waveform.state}
        onClick={(event) => {
          const el = ref.current
          if (!el || !state.duration) return
          const rect = event.currentTarget.getBoundingClientRect()
          const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
          el.currentTime = ratio * state.duration
        }}
      />
      <MediaControls media={ref} state={state} />
      <p className="fv-note" data-tone={waveform.state === 'failed' ? 'error' : undefined}>
        {!state.ready ? t('files.viewer.loading') : reason ? `${formatTime(state.duration)} · ${reason}` : formatTime(state.duration)}
      </p>
    </Frame>
  )
}
