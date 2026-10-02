import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileItem } from '@shared/files'
import { baseName } from '@shared/file-path'
import { Frame } from './Frame'
import { formatTime, waveformBars } from './media'
import { MediaControls, useMediaState } from './MediaControls'
import { openPreviewDocument } from './preview-client'
import type { Viewer } from './types'
import './MediaViewer.css'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'
import type openAudio from '@/preview/methods/audio'

/**
 * Audio. The <audio> element stays hidden and the waveform together with MediaControls drives it; it plays the file
 * by ranges, at any size. The waveform is built in the preview page (preview/methods/audio.ts), which reads the
 * file from its start a piece at a time, and is drawn as its peaks come, the part not read yet as a flat line.
 * Pressing the waveform seeks to that position.
 */
const BARS = 400

/** The recordings that get a waveform. FLAC and OGG play without one. */
const WITH_WAVEFORM = new Set(['.mp3', '.m4a', '.aac', '.wav'])

function drawsWaveform(path: string): boolean {
  const name = baseName(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot >= 0 && WITH_WAVEFORM.has(name.slice(dot))
}

type Waveform =
  | { state: 'loading' | 'unsupported' }
  | { state: 'drawing' | 'ready'; peaks: Float32Array; peakSeconds: number; seconds: number }
  | { state: 'failed'; message: string }

function useWaveform({ path, url, sizeBytes, modifiedAt }: FileItem): Waveform {
  const [waveform, setWaveform] = useState<Waveform>({ state: 'loading' })
  useEffect(() => {
    if (!url) return
    if (!drawsWaveform(path)) {
      setWaveform({ state: 'unsupported' })
      return
    }
    setWaveform({ state: 'loading' })
    const preview = openPreviewDocument<typeof openAudio>('audio', { url, sizeBytes, modifiedAt })
    let cancelled = false
    void (async () => {
      let peaks = new Float32Array(0)
      try {
        for (;;) {
          const answer = await preview.call('peaks', { from: peaks.length })
          if (cancelled) return
          if (!answer.supported) {
            setWaveform({ state: 'unsupported' })
            return
          }
          const grown = new Float32Array(peaks.length + answer.peaks.length)
          grown.set(peaks)
          grown.set(answer.peaks, peaks.length)
          peaks = grown
          setWaveform({ state: answer.done ? 'ready' : 'drawing', peaks, peakSeconds: answer.peakSeconds, seconds: answer.seconds })
          if (answer.done) return
        }
      } catch (error) {
        if (!cancelled) setWaveform({ state: 'failed', message: displayError(error) })
      }
    })()
    return () => {
      cancelled = true
      preview.release()
    }
  }, [path, url, sizeBytes, modifiedAt])
  return waveform
}

/**
 * Draws the waveform on the canvas: the bars read so far, then a flat line in the middle for the rest. What has
 * been played is brighter. A canvas takes no CSS, so the colors are read from the theme's tokens on the canvas at
 * each draw.
 */
function drawWaveform(canvas: HTMLCanvasElement, bars: Float32Array, progress: number): void {
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
  const step = width / BARS
  const bar = Math.max(1, step * 0.7)
  const playedUntil = width * progress
  for (let i = 0; i < bars.length; i++) {
    const x = i * step
    const h = Math.max(1, bars[i] * (height - 4))
    ctx.fillStyle = x < playedUntil ? played : unplayed
    ctx.fillRect(x, mid - h / 2, bar, h)
  }
  const restFrom = bars.length * step
  if (restFrom >= width) return
  ctx.fillStyle = unplayed
  ctx.fillRect(restFrom, mid - 1, width - restFrom, 2)
  if (playedUntil > restFrom) {
    ctx.fillStyle = played
    ctx.fillRect(restFrom, mid - 1, playedUntil - restFrom, 2)
  }
}

export const AudioViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const ref = useRef<HTMLAudioElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const state = useMediaState(ref)
  const waveform = useWaveform(item)
  const [error, setError] = useState<string | null>(null)
  const progress = state.duration > 0 ? state.current / state.duration : 0
  const bars = useMemo(
    () => (waveform.state === 'drawing' || waveform.state === 'ready' ? waveformBars(waveform.peaks, waveform.peakSeconds, waveform.seconds, BARS) : new Float32Array(0)),
    [waveform]
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const draw = (): void => drawWaveform(canvas, bars, progress)
    draw()
    const resize = new ResizeObserver(draw)
    resize.observe(canvas)
    const theme = new MutationObserver(draw)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      resize.disconnect()
      theme.disconnect()
    }
  }, [bars, progress])

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
    waveform.state === 'unsupported'
      ? t('files.viewer.waveformUnsupported')
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
