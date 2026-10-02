import type { FileItem } from '@shared/files'

/**
 * The video and audio samples. They sit in the folder of a separate job, as the recording of an
 * interview. The files themselves live in demo-public/demo-files/media and were made like this, with
 * scratchpad's make-media.mjs and ffmpeg:
 * - interview.mp4: ffmpeg -f lavfi -i testsrc2=size=160x120:rate=12 -t 3 -c:v libx264 -pix_fmt yuv420p -crf 34 -movflags +faststart -an
 * - interview.wav: 8kHz 16bit mono, 2.5 seconds, written in Node as a decaying tone that rises in pitch every 0.5 seconds.
 */
const DIR = '/Users/demo/asist-jobs/20260918-153000-interview'
const now = Date.now()

export const DEMO_MEDIA_ITEMS: FileItem[] = [
  { path: `${DIR}/interview.mp4`, name: 'interview.mp4', kind: 'video', sizeBytes: 13475, modifiedAt: now - 26 * 3600_000, url: '/demo-files/media/interview.mp4' },
  { path: `${DIR}/interview.wav`, name: 'interview.wav', kind: 'audio', sizeBytes: 40044, modifiedAt: now - 26 * 3600_000, url: '/demo-files/media/interview.wav' }
]

export const DEMO_VIDEO_PATH = DEMO_MEDIA_ITEMS[0].path
export const DEMO_AUDIO_PATH = DEMO_MEDIA_ITEMS[1].path
