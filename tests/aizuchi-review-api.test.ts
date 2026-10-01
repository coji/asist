import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { audioPath, decide, listClips } from '../scripts/aizuchi-clips/review-api.mjs'

/** A checkout with one Irodori-TTS voice: a clip rendered with two candidates, and one rendered before candidates were kept. */
let root = ''
const voiceDir = (): string => path.join(root, 'resources', 'aizuchi', 'irodori', 'calm')
const candidateDir = (): string => path.join(root, '.aizuchi-candidates', 'irodori', 'calm', 'aaa')
const manifest = (): { clips: Array<Record<string, unknown>> } => JSON.parse(fs.readFileSync(path.join(voiceDir(), 'manifest.json'), 'utf8'))

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-aizuchi-review-'))
  fs.mkdirSync(voiceDir(), { recursive: true })
  fs.mkdirSync(candidateDir(), { recursive: true })
  fs.writeFileSync(path.join(candidateDir(), '0.wav'), 'first')
  fs.writeFileSync(path.join(candidateDir(), '1.wav'), 'second')
  fs.writeFileSync(path.join(candidateDir(), 'candidates.json'), JSON.stringify([
    { file: '0.wav', heard: 'うん。', voicedMs: 500, exact: true },
    { file: '1.wav', heard: 'うん。', voicedMs: 520, exact: true }
  ]))
  fs.writeFileSync(path.join(voiceDir(), 'aaa.wav'), 'first')
  fs.writeFileSync(path.join(voiceDir(), 'bbb.wav'), 'older')
  fs.writeFileSync(path.join(voiceDir(), 'manifest.json'), JSON.stringify({
    voice: 'calm',
    language: 'ja',
    clips: [{ text: 'うん。', file: 'aaa.wav' }, { text: 'はい。', file: 'bbb.wav', reviewed: true }]
  }))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('the aizuchi review of the demo', () => {
  it('lists every clip with its verdict, its candidates and which of them it is now', () => {
    expect(listClips(root)).toEqual([
      expect.objectContaining({ engine: 'irodori', voice: 'calm', text: 'うん。', status: 'unreviewed', current: 0, candidates: expect.arrayContaining([expect.objectContaining({ file: '1.wav' })]) }),
      expect.objectContaining({ text: 'はい。', status: 'accepted', current: null, candidates: [] })
    ])
  })

  it('copies the chosen candidate over the clip and marks it reviewed, so that build.mjs keeps it', () => {
    decide(root, { engine: 'irodori', voice: 'calm', file: 'aaa.wav', verdict: 'accept', candidate: 1 })
    expect(fs.readFileSync(path.join(voiceDir(), 'aaa.wav'), 'utf8')).toBe('second')
    expect(manifest().clips[0]).toMatchObject({ reviewed: true })
    expect(listClips(root)[0]).toMatchObject({ status: 'accepted', current: 1 })
  })

  it('keeps the clip as it is when it is accepted without a candidate, as one rendered before candidates were kept', () => {
    decide(root, { engine: 'irodori', voice: 'calm', file: 'bbb.wav', verdict: 'undo' })
    decide(root, { engine: 'irodori', voice: 'calm', file: 'bbb.wav', verdict: 'accept', candidate: null })
    expect(fs.readFileSync(path.join(voiceDir(), 'bbb.wav'), 'utf8')).toBe('older')
    expect(manifest().clips[1]).toMatchObject({ reviewed: true })
  })

  it('keeps the note of a rejected clip until it is decided again, and takes a verdict back on undo', () => {
    decide(root, { engine: 'irodori', voice: 'calm', file: 'bbb.wav', verdict: 'reject', note: '語尾が切れる' })
    expect(manifest().clips[1]).toEqual({ text: 'はい。', file: 'bbb.wav', rejected: '語尾が切れる' })
    expect(listClips(root)[1]).toMatchObject({ status: 'rejected', note: '語尾が切れる' })
    decide(root, { engine: 'irodori', voice: 'calm', file: 'bbb.wav', verdict: 'undo' })
    expect(manifest().clips[1]).toEqual({ text: 'はい。', file: 'bbb.wav' })
  })

  it('refuses a name that would leave the folders of the clips', () => {
    expect(() => decide(root, { engine: '..', voice: 'calm', file: 'aaa.wav', verdict: 'accept', candidate: 0 })).toThrow('not a name')
    expect(() => audioPath(root, ['irodori', '..', 'aaa.wav'])).toThrow('not a name')
    expect(audioPath(root, ['irodori', 'calm', 'aaa', '1.wav'])).toBe(path.join(candidateDir(), '1.wav'))
  })
})
