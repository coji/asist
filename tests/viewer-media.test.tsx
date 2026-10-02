// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatBytes, type FileItem } from '@shared/files'
import { createTranslator } from '@shared/i18n'
import { errorKey } from '@shared/i18n/error-key'
import { FileViewer } from '@/panels/viewers'
import { AudioViewer } from '@/panels/viewers/AudioViewer'
import { formatTime, waveformBars } from '@/panels/viewers/media'
import { VideoViewer } from '@/panels/viewers/VideoViewer'
import type { ViewerProps } from '@/panels/viewers/types'
import type { PeaksAnswer } from '@/preview/methods/audio'

/**
 * The video and audio viewers, the pure logic (time formatting, the bars of a waveform) and the DOM behavior of the
 * controls, and the placard a zip gets. happy-dom does not play media, so play and pause on the media element are
 * replaced and the events are dispatched by hand. The audio viewer's waveform comes from the preview page, which
 * happy-dom cannot run, so the document it opens there is one whose answers each test gives by hand.
 */

const preview = vi.hoisted(() => ({
  open: vi.fn(),
  calls: [] as Array<{ from: number; answer: (value: unknown) => void; fail: (error: Error) => void }>,
  release: vi.fn()
}))
vi.mock('@/panels/viewers/preview-client', () => ({ openPreviewDocument: preview.open }))

describe('time formatting', () => {
  it('formats minutes and seconds, adds hours past an hour, and shows 0:00 while the duration is unknown', () => {
    expect(formatTime(3.9)).toBe('0:03')
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(3723)).toBe('1:02:03')
    expect(formatTime(NaN)).toBe('0:00')
    expect(formatTime(Infinity)).toBe('0:00')
  })
})

describe('the bars of a waveform', () => {
  const bars = (peaks: number[], peakSeconds: number, seconds: number, count: number): number[] =>
    [...waveformBars(Float32Array.from(peaks), peakSeconds, seconds, count)].map((height) => Math.round(height * 1000) / 1000)

  it('takes the largest peak within each bar and scales the largest bar to 1', () => {
    expect(bars([0.1, 0.5, 0.2, 0.8], 1, 4, 2)).toEqual([0.625, 1])
    expect(bars([0, 0, 0, 0], 1, 4, 2)).toEqual([0, 0])
  })

  it('gives only the bars the peaks read so far reach, while the recording is still read', () => {
    expect(bars([0.2, 0.4], 1, 10, 10)).toEqual([0.5, 1])
    expect(bars([0.2, 0.4, 0.1], 1, 10, 4)).toEqual([1, 0.25])
    expect(bars([], 1, 10, 10)).toEqual([])
  })

  it('gives each bar narrower than a peak the peak it starts in', () => {
    expect(bars([0.5, 1], 2, 4, 4)).toEqual([0.5, 0.5, 1, 1])
  })

  it('draws a recording longer than its header said to the end of its peaks', () => {
    expect(bars([0.2, 0.4, 0.6, 0.8], 1, 2, 2)).toEqual([0.5, 1])
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
    preview.calls.length = 0
    preview.release.mockClear()
    preview.open.mockReset()
    preview.open.mockImplementation(() => ({
      call: (_method: string, { from }: { from: number }) =>
        new Promise((resolve, reject) => preview.calls.push({ from, answer: resolve, fail: reject })),
      release: preview.release
    }))
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

  /** Answers the viewer's last request for the peaks. */
  async function answer(value: PeaksAnswer | Error): Promise<void> {
    const call = preview.calls.at(-1)!
    await act(async () => {
      if (value instanceof Error) call.fail(value)
      else call.answer(value)
    })
  }
  const peaks = (values: number[], done: boolean): PeaksAnswer => ({ supported: true, peaks: Float32Array.from(values), peakSeconds: 1, seconds: 8, done })
  const t = createTranslator('ja-JP')

  it('draws the waveform of a recording of any size as its peaks come from the preview page, asking each time from where it has got to', async () => {
    const huge = { ...audio, sizeBytes: 2 ** 40, modifiedAt: 1_790_000_000_000 }
    const card = await render(AudioViewer, huge)
    expect(preview.open).toHaveBeenCalledWith('audio', { url: huge.url, sizeBytes: huge.sizeBytes, modifiedAt: huge.modifiedAt })
    const wave = card.querySelector('.fv-media-wave')!
    expect(wave.getAttribute('data-state')).toBe('loading')
    expect(preview.calls.map((call) => call.from)).toEqual([0])

    await answer(peaks([0.2, 0.9, 0.4], false))
    expect(wave.getAttribute('data-state')).toBe('drawing')
    await answer(peaks([0.3, 0.1, 0.5, 0.6, 0.2], true))
    expect(wave.getAttribute('data-state')).toBe('ready')
    expect(preview.calls.map((call) => call.from)).toEqual([0, 3])
    await loadMetadata(card.querySelector('audio')!, 8)
    expect(card.querySelector('.fv-note')?.textContent).toBe('0:08')
    expect(preview.release).not.toHaveBeenCalled()
  })

  it.each(['memo.flac', 'memo.ogg'])('draws no waveform for %s and says so, without opening the preview page', async (name) => {
    const card = await render(AudioViewer, { ...audio, path: `/v/${name}`, name })
    expect(preview.open).not.toHaveBeenCalled()
    expect(card.querySelector('.fv-media-wave')?.getAttribute('data-state')).toBe('unsupported')
    await loadMetadata(card.querySelector('audio')!, 65)
    expect(card.querySelector('.fv-note')?.textContent).toBe(`1:05 · ${t('files.viewer.waveformUnsupported')}`)
  })

  it('says a recording the preview page draws no waveform of gets none', async () => {
    const card = await render(AudioViewer, audio)
    await answer({ supported: false })
    await loadMetadata(card.querySelector('audio')!, 2)
    expect(card.querySelector('.fv-media-wave')?.getAttribute('data-state')).toBe('unsupported')
    expect(card.querySelector('.fv-note')?.textContent).toBe(`0:02 · ${t('files.viewer.waveformUnsupported')}`)
  })

  it('says why the waveform failed, in the language of the screen, when the preview page fails it', async () => {
    const card = await render(AudioViewer, audio)
    await answer(peaks([0.5], false))
    await answer(new Error(errorKey('files.errors.audioDamaged')))
    await loadMetadata(card.querySelector('audio')!, 2)
    const note = card.querySelector('.fv-note')!
    expect(note.getAttribute('data-tone')).toBe('error')
    expect(note.textContent).toBe(`0:02 · ${t('files.viewer.waveformFailed', { message: t('files.errors.audioDamaged') })}`)
  })

  it('lets go of the document in the preview page when it is closed, and asks for nothing after', async () => {
    await render(AudioViewer, audio)
    await act(async () => root.render(null))
    expect(preview.release).toHaveBeenCalledTimes(1)
    await answer(peaks([0.5], false))
    expect(preview.calls).toHaveLength(1)
  })

  it('seeks to the matching fraction of the track when the waveform is clicked', async () => {
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
