import { describe, expect, it } from 'vitest'
import { ECHO_TAIL_MS, isSelfEcho, normalizeForEcho, PlaybackLog, stripClipEcho, type ClipEdges } from '@shared/self-echo'

describe('normalizeForEcho', () => {
  it('removes punctuation, spaces and symbols and lowercases the rest', () => {
    expect(normalizeForEcho('明日は、晴れです。 (たぶん)')).toBe('明日は晴れですたぶん')
    expect(normalizeForEcho('OK Google')).toBe('okgoogle')
  })
})

describe('isSelfEcho', () => {
  const recent = ['明日の東京は晴れで、最高気温は28度です。', '傘は要らなそうですよ。']

  it('treats a complete loopback of a recent utterance as an echo', () => {
    expect(isSelfEcho('明日の東京は晴れで最高気温は28度です', recent)).toBe(true)
  })

  it('treats a loopback of only part of a sentence, recorded from partway through, as an echo', () => {
    expect(isSelfEcho('最高気温は28度です', recent)).toBe(true)
    expect(isSelfEcho('傘は要らなそうですよ', recent)).toBe(true)
  })

  it('treats a loopback that spans a sentence boundary as an echo', () => {
    expect(isSelfEcho('28度です。傘は要らな', recent)).toBe(true)
  })

  it('judges by bigram overlap, so a few characters of ASR drift still count as an echo', () => {
    // The transcript drifts, as when "最高気温は28度です" comes back as "再考気温は28度です".
    expect(isSelfEcho('明日の東京は晴れで最高気温は28度れす', recent)).toBe(true)
  })

  it('does not treat a new user utterance as an echo', () => {
    expect(isSelfEcho('じゃあ大阪の天気はどう?', recent)).toBe(false)
    expect(isSelfEcho('ありがとう、助かった', recent)).toBe(false)
  })

  it('lets a different sentence on the same topic through, since overlapping words alone are not enough', () => {
    expect(isSelfEcho('東京より大阪の気温が知りたいんだけど', recent)).toBe(false)
  })

  it('does not judge a short utterance such as an aizuchi, where a false positive is likely', () => {
    expect(isSelfEcho('はい', recent)).toBe(false)
    expect(isSelfEcho('うん。', recent)).toBe(false)
  })

  it('returns false when there is no recent utterance', () => {
    expect(isSelfEcho('明日の東京は晴れで最高気温は28度です', [])).toBe(false)
  })
})

describe('isSelfEcho in a language written with spaces', () => {
  const recent = ['Tomorrow in Tokyo it will be sunny, with a high of twenty-eight degrees.', 'You will not need an umbrella.']

  it('treats a loopback of a recent reply as an echo', () => {
    expect(isSelfEcho('tomorrow in tokyo it will be sunny with a high of twenty eight degrees', recent)).toBe(true)
    expect(isSelfEcho('you will not need an umbrella', recent)).toBe(true)
  })

  it('counts the overlap word by word, so a word the transcript got wrong still counts as an echo', () => {
    expect(isSelfEcho('tomorrow in tokyo it will be sunny with a high of twenty eight degrease', recent)).toBe(true)
  })

  it('does not read the last word of one reply and the first of the next as a single word', () => {
    expect(isSelfEcho('you will not need an umbrella today', ['Tomorrow will be sunny.', 'You will not need an umbrella.'])).toBe(true)
  })

  it('lets a new utterance through even when it is about the same thing', () => {
    expect(isSelfEcho('what about the temperature in Osaka instead', recent)).toBe(false)
    expect(isSelfEcho('thanks, that helps a lot', recent)).toBe(false)
  })
})

describe('stripClipEcho removes an aizuchi clip that leaked into the transcript', () => {
  const CLIPS = ['はい。', 'うんうん。', 'ええ。']
  const atBothEdges = (clips: string[]): ClipEdges => ({ leading: clips, trailing: clips })

  it('strips a leading clip, with or without the punctuation that follows it', () => {
    expect(stripClipEcho('はい明日の天気教えて', atBothEdges(CLIPS))).toBe('明日の天気教えて')
    expect(stripClipEcho('はい、明日の天気教えて', atBothEdges(CLIPS))).toBe('明日の天気教えて')
  })

  it('strips a clip that leaked in at the end', () => {
    expect(stripClipEcho('お願いします はい', atBothEdges(CLIPS))).toBe('お願いします')
  })

  it('returns an empty string when the whole utterance is an echo, so the caller can drop it', () => {
    expect(stripClipEcho('はい', atBothEdges(CLIPS))).toBe('')
    expect(stripClipEcho('うんうん', atBothEdges(CLIPS))).toBe('')
    expect(stripClipEcho('はい。うんうん。', atBothEdges(CLIPS))).toBe('')
  })

  it('leaves a clip word in the middle of a sentence alone, so a real utterance is not broken', () => {
    expect(stripClipEcho('じゃあはいって返事して', atBothEdges(CLIPS))).toBe('じゃあはいって返事して')
  })

  it('passes the text through when there is no clip candidate', () => {
    expect(stripClipEcho('はい', atBothEdges([]))).toBe('はい')
  })

  it('strips the longest matching clip first, so a doubled aizuchi is not read as the short clip twice', () => {
    expect(stripClipEcho('はいはいわかりました', atBothEdges(['はいはい。', 'はい。']))).toBe('わかりました')
  })

  it('strips each end only of the clips that can sit there', () => {
    const clips = { leading: ['はい。'], trailing: ['なるほど。'] }
    expect(stripClipEcho('なるほどね、それではい', clips)).toBe('なるほどね、それではい')
    expect(stripClipEcho('はい、それでなるほど', clips)).toBe('それで')
  })

  it('strips the punctuation of any language around the clip, not only the marks Japanese writes', () => {
    expect(stripClipEcho('Right, what is the weather tomorrow?', atBothEdges(['Right.']))).toBe('what is the weather tomorrow?')
    expect(stripClipEcho('¿Sí? dime la hora', atBothEdges(['Sí']))).toBe('dime la hora')
  })
})

describe('PlaybackLog tells what the microphone can have picked up during a capture', () => {
  const question = { text: 'クラシックとジャズ、どちらを再生しますか？' }
  const texts = (log: PlaybackLog, from: number, to: number): string[] => log.heardDuring({ startedAt: from, endedAt: to })

  it('leaves out a question that finished before the answer was captured, so the answer is judged on its own', () => {
    const log = new PlaybackLog()
    log.started(question, 1000)
    log.stopped(3500)
    const heard = texts(log, 3500 + ECHO_TAIL_MS + 50, 4400)
    expect(heard).toEqual([])
    expect(isSelfEcho('クラシック', heard)).toBe(false)
  })

  it('includes a sound that was playing, or still echoing, during the capture', () => {
    const log = new PlaybackLog()
    log.started(question, 1000)
    log.stopped(3500)
    // Captured while the question played, and captured inside its echo tail.
    expect(texts(log, 3000, 3800)).toEqual([question.text])
    expect(texts(log, 3500 + ECHO_TAIL_MS - 50, 4400)).toEqual([question.text])
    // A sound still playing reaches every capture that starts after it.
    log.started({ text: '再生します。' }, 5000)
    expect(texts(log, 9000, 9500)).toEqual(['再生します。'])
  })

  it('leaves out a clip that starts only after the capture ended, such as the aizuchi played at speech end', () => {
    const log = new PlaybackLog()
    log.started({ text: 'はい。', clip: 'aizuchi' }, 4400)
    expect(texts(log, 2000, 4400)).toEqual([])
    expect(texts(log, 4000, 4500)).toEqual(['はい。'])
  })

  it('offers a clip to the start of a transcript only if it sounded as the speech began, and to the end only if it sounded as the voice was last heard', () => {
    const log = new PlaybackLog()
    // The opening aizuchi of the utterance before still sounds as this speech begins.
    log.started({ text: 'はい。', clip: 'aizuchi' }, 900)
    log.stopped(1300)
    // A listening aizuchi at a break inside the speech, which goes on after it.
    log.started({ text: 'なるほど。', clip: 'listening' }, 3000)
    log.stopped(3500)
    // Another at the last break, after which the user says nothing more.
    log.started({ text: 'うん。', clip: 'listening' }, 5000)
    log.stopped(5300)

    expect(log.clipsAtEdges({ startedAt: 1000, speechEndAt: 5200, endedAt: 5550 })).toEqual({ leading: ['はい。'], trailing: ['うん。'] })
    // A capture of nothing but the clip's echo can have it at both ends.
    expect(log.clipsAtEdges({ startedAt: 950, speechEndAt: 1250, endedAt: 1600 })).toEqual({ leading: ['はい。'], trailing: ['はい。'] })
  })

  it('ends a sound when the next one starts', () => {
    const log = new PlaybackLog()
    log.started({ text: '一文目です。' }, 1000)
    log.started({ text: '二文目です。' }, 2000)
    log.stopped(3000)
    expect(texts(log, 2000 + ECHO_TAIL_MS + 10, 2800)).toEqual(['二文目です。'])
  })
})
