// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatBytes, type FileItem } from '@shared/files'
import { createTranslator } from '@shared/i18n'
import { FileViewer } from '@/panels/viewers'
import { AudioViewer } from '@/panels/viewers/AudioViewer'
import { downsampleWaveform, formatTime } from '@/panels/viewers/media'
import { VideoViewer } from '@/panels/viewers/VideoViewer'
import type { ViewerProps } from '@/panels/viewers/types'

/**
 * The video and audio viewers, the pure logic (time formatting, waveform downsampling) and the DOM behavior of the
 * controls, and the placard a zip gets. happy-dom does not play media, so play and pause on the media element are
 * replaced and the events are dispatched by hand.
 */

describe('time formatting', () => {
  it('formats minutes and seconds, adds hours past an hour, and shows 0:00 while the duration is unknown', () => {
    expect(formatTime(3.9)).toBe('0:03')
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(3723)).toBe('1:02:03')
    expect(formatTime(NaN)).toBe('0:00')
    expect(formatTime(Infinity)).toBe('0:00')
  })
})

describe('waveform downsampling', () => {
  it('takes the peak amplitude of each bucket across all channels and normalizes the largest to 1', () => {
    const left = new Float32Array([0.1, -0.4, 0.2, 0.0, 0.1, 0.1])
    const right = new Float32Array([0.0, 0.0, 0.0, -0.8, 0.0, 0.0])
    expect(downsampleWaveform([left, right], 3)).toEqual([0.5, 1, 0.125])
  })

  it('returns one value per bucket even with fewer samples than buckets and leaves silence at 0', () => {
    expect(downsampleWaveform([new Float32Array([0, 0])], 4)).toEqual([0, 0, 0, 0])
    expect(downsampleWaveform([new Float32Array([0.5])], 2)).toHaveLength(2)
    expect(downsampleWaveform([], 3)).toEqual([])
  })
})

describe('viewer rendering', () => {
  let container: HTMLDivElement
  let root: Root
  const play = vi.fn(async () => {})
  const pause = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      }
    )
    play.mockClear()
    pause.mockClear()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** Mounts with a new key every time, so rendering the same item twice still starts again from the fetch. */
  let mounts = 0
  async function render(Viewer: React.FC<ViewerProps>, item: FileItem, size: ViewerProps['size'] = 'l'): Promise<HTMLElement> {
    await act(async () => {
      root.render(
        React.createElement('div', { className: 'card', 'data-size': size }, React.createElement(Viewer, { key: mounts++, item, mode: size === 'focus' ? 'focus' : 'card', size }))
      )
    })
    return container.querySelector<HTMLElement>('.card')!
  }

  /** happy-dom never loads metadata, so the duration and the position are made writable and the event is sent by hand. */
  async function loadMetadata(el: HTMLMediaElement, duration: number, extra: Record<string, unknown> = {}): Promise<void> {
    Object.defineProperty(el, 'duration', { value: duration, configurable: true })
    Object.defineProperty(el, 'readyState', { value: 1, configurable: true })
    for (const [key, value] of Object.entries(extra)) Object.defineProperty(el, key, { value, configurable: true })
    await act(async () => {
      el.dispatchEvent(new Event('loadedmetadata'))
    })
  }

  const video: FileItem = { path: '/v/clip.mp4', name: 'clip.mp4', kind: 'video', sizeBytes: 13475, url: '/demo-files/media/interview.mp4' }
  const audio: FileItem = { path: '/v/tone.wav', name: 'tone.wav', kind: 'audio', sizeBytes: 40044, url: '/demo-files/media/interview.wav' }

  it('keeps the video controls disabled until the metadata arrives, then notes the duration and size and passes play and pause to the element', async () => {
    const card = await render(VideoViewer, video)
    const el = card.querySelector('video')!
    expect(el.hasAttribute('autoplay')).toBe(false)
    expect(el.hasAttribute('controls')).toBe(false)
    const playButton = card.querySelector<HTMLButtonElement>('[aria-label="再生"]')!
    expect(playButton.disabled).toBe(true)
    expect(card.querySelector('.fv-note')?.textContent).toBe(createTranslator('ja-JP')('files.viewer.loading'))

    await loadMetadata(el, 3, { videoWidth: 160, videoHeight: 120 })
    expect(card.querySelector('.fv-note')?.textContent).toBe('0:03 · 160×120')
    expect(playButton.disabled).toBe(false)
    expect(card.querySelector<HTMLInputElement>('.fv-media-seek')?.max).toBe('3')

    await act(async () => playButton.click())
    expect(play).toHaveBeenCalledTimes(1)
    Object.defineProperty(el, 'paused', { value: false, configurable: true })
    await act(async () => {
      el.dispatchEvent(new Event('play'))
    })
    const pauseButton = card.querySelector<HTMLButtonElement>('[aria-label="一時停止"]')!
    await act(async () => pauseButton.click())
    expect(pause).toHaveBeenCalledTimes(1)
  })

  it('follows timeupdate on the seek bar, writes currentTime when it is dragged, and toggles muted on the element', async () => {
    const card = await render(VideoViewer, video)
    const el = card.querySelector('video')!
    await loadMetadata(el, 10)
    el.currentTime = 4
    await act(async () => {
      el.dispatchEvent(new Event('timeupdate'))
    })
    const seek = card.querySelector<HTMLInputElement>('.fv-media-seek')!
    expect(seek.value).toBe('4')
    expect([...card.querySelectorAll('.fv-media-time')].map((node) => node.textContent)).toEqual(['0:04', '0:10'])

    // A controlled React input fires onChange only when the value is set through the native setter before the input event.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(seek, '7.5')
    await act(async () => {
      seek.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(el.currentTime).toBe(7.5)

    await act(async () => card.querySelector<HTMLButtonElement>('[aria-label="消音"]')!.click())
    expect(el.muted).toBe(true)
    await act(async () => {
      el.dispatchEvent(new Event('volumechange'))
    })
    expect(card.querySelector('[aria-label="消音を解く"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('decodes the audio bytes to build the waveform and declines with a note instead of decoding a file that is too large', async () => {
    const decodeAudioData = vi.fn(async () => ({ numberOfChannels: 1, getChannelData: () => new Float32Array([0.2, 0.9, 0.1, 0.4]) }))
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = decodeAudioData
        close = async (): Promise<void> => {}
      }
    )
    const fetch = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))
    vi.stubGlobal('fetch', fetch)

    const card = await render(AudioViewer, audio)
    await act(async () => {
      await Promise.resolve()
    })
    expect(fetch).toHaveBeenCalledWith(audio.url)
    expect(decodeAudioData).toHaveBeenCalledTimes(1)
    expect(card.querySelector('.fv-media-wave')?.getAttribute('data-state')).toBe('ready')
    await loadMetadata(card.querySelector('audio')!, 2.5)
    expect(card.querySelector('.fv-note')?.textContent).toBe('0:02')

    fetch.mockClear()
    decodeAudioData.mockClear()
    const big = await render(AudioViewer, { ...audio, sizeBytes: 21 * 1024 * 1024 })
    expect(fetch).not.toHaveBeenCalled()
    expect(decodeAudioData).not.toHaveBeenCalled()
    expect(big.querySelector('.fv-media-wave')?.getAttribute('data-state')).toBe('skipped')
    await loadMetadata(big.querySelector('audio')!, 600)
    expect(big.querySelector('.fv-note')?.textContent).toBe(`10:00 · ${createTranslator('ja-JP')('files.viewer.waveformTooLarge', { size: '21.0MB' })}`)
  })

  it('seeks to the matching fraction of the track when the waveform is clicked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })))
    const card = await render(AudioViewer, audio)
    const el = card.querySelector('audio')!
    await loadMetadata(el, 8)
    const wave = card.querySelector<HTMLCanvasElement>('.fv-media-wave')!
    vi.spyOn(wave, 'getBoundingClientRect').mockReturnValue({ left: 100, width: 200, top: 0, height: 72, right: 300, bottom: 72, x: 100, y: 0, toJSON: () => ({}) })
    await act(async () => {
      wave.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 150 }))
    })
    expect(el.currentTime).toBe(2)
  })

  it('shows a zip as a file it has no viewer for, with its path and size, and never reads it', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const archive: FileItem = { path: '/v/handout.zip', name: 'handout.zip', kind: 'archive', sizeBytes: 2249, url: '/demo-files/media/handout.zip' }
    const card = await render(FileViewer, archive)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(fetch).not.toHaveBeenCalled()
    const t = createTranslator('ja-JP')
    expect(card.querySelector('.fv-stub span')?.textContent).toBe(t('files.viewer.stub', { kind: t('files.kind.archive') }))
    expect(card.querySelector('.fv-stub small')?.textContent).toBe(`/v/handout.zip · ${formatBytes(2249)}`)
  })
})
