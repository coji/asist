import { describe, expect, it } from 'vitest'
import { SegmentAssembler } from '@shared/segmenter'

describe('SegmentAssembler in Japanese', () => {
  it('ends a segment at sentence-ending punctuation', () => {
    const a = new SegmentAssembler('ja-JP')
    expect(a.push('こんにちは。').sentences).toEqual(['こんにちは。'])
    expect(a.push('元気ですか?').sentences).toEqual(['元気ですか?'])
    expect(a.push('全角も！対応？する\n').sentences).toEqual(['全角も！', '対応？', 'する'])
  })

  it('assembles a sentence across deltas that cut it in the middle', () => {
    const a = new SegmentAssembler('ja-JP')
    expect(a.push('今日はいい').sentences).toEqual([])
    expect(a.push('天気です').sentences).toEqual([])
    expect(a.push('ね。明日は').sentences).toEqual(['今日はいいですね。'.replace('です', '天気です')])
    expect(a.flush()).toEqual(['明日は'])
  })

  it('splits at a comma once the segment exceeds 50 characters, so playback of a long reply starts sooner', () => {
    const a = new SegmentAssembler('ja-JP')
    const long = 'あ'.repeat(55)
    const out = a.push(`${long}、続きです。`).sentences
    expect(out[0]).toBe(`${long}、`)
    expect(out[1]).toBe('続きです。')
  })

  it('does not split at a comma while the segment is 50 characters or shorter', () => {
    const a = new SegmentAssembler('ja-JP')
    expect(a.push('短い文、続き。').sentences).toEqual(['短い文、続き。'])
  })

  it('flushes the remainder and drops a segment that is empty or only a comma', () => {
    const a = new SegmentAssembler('ja-JP')
    a.push('、')
    expect(a.flush()).toEqual([])
    a.push('残り')
    expect(a.flush()).toEqual(['残り'])
    expect(a.flush()).toEqual([])
  })

  it('collapses runs of markdown marks into a space so they are not read aloud', () => {
    const a = new SegmentAssembler('ja-JP')
    expect(a.push('見出し**強調**です。').sentences).toEqual(['見出し 強調 です。'])
  })

  it('hands no piece made only of punctuation to the speech engine, such as the mark after "!" or the closing bracket after "。"', () => {
    const a = new SegmentAssembler('ja-JP')
    expect([...a.push('えっ!?本当ですか！？「そうです。」').sentences, ...a.flush()]).toEqual(['えっ!', '本当ですか！', '「そうです。'])
  })
})

describe('SegmentAssembler in the languages that end a sentence in a full stop', () => {
  it('emits a sentence only once the text after it proves the full stop ended it', () => {
    const a = new SegmentAssembler('en-US')
    expect(a.push('Hello there.').sentences).toEqual([])
    expect(a.push(' How are').sentences).toEqual(['Hello there.'])
    expect(a.push(' you?').sentences).toEqual([])
    expect(a.flush()).toEqual(['How are you?'])
  })

  it('keeps a decimal number inside its sentence', () => {
    const a = new SegmentAssembler('de-DE')
    expect(a.push('Es sind 3.5 Grad und es wird kälter. Morgen schneit es. ').sentences).toEqual([
      'Es sind 3.5 Grad und es wird kälter.'
    ])
    expect(a.flush()).toEqual(['Morgen schneit es.'])
  })

  it('reads the two halves of an abbreviation one after the other, because V8 suppresses none', () => {
    const a = new SegmentAssembler('de-DE')
    expect(a.push('Das ist z. B. wichtig. Und dann? ').sentences).toEqual(['Das ist z.', 'B. wichtig.'])
    expect(a.flush()).toEqual(['Und dann?'])
  })

  it('ends a Hindi sentence at the danda', () => {
    const a = new SegmentAssembler('hi-IN')
    expect(a.push('नमस्ते। आप कैसे हैं? ').sentences).toEqual(['नमस्ते।'])
    expect(a.flush()).toEqual(['आप कैसे हैं?'])
  })

  it('ends a Korean sentence at the full stop', () => {
    const a = new SegmentAssembler('ko-KR')
    expect(a.push('안녕하세요. 잘 지내세요? ').sentences).toEqual(['안녕하세요.'])
    expect(a.flush()).toEqual(['잘 지내세요?'])
  })

  it('cuts a long sentence at the comma that follows twenty words, so playback starts sooner', () => {
    const a = new SegmentAssembler('en-US')
    const long = Array(25).fill('word').join(' ')
    expect(a.push(`${long}, and the rest follows`).sentences).toEqual([`${long},`])
    expect(a.flush()).toEqual(['and the rest follows'])
  })

  it('does not cut a sentence that stays under the limit at its comma', () => {
    const a = new SegmentAssembler('en-US')
    expect(a.push('It is short, and it stays whole').sentences).toEqual([])
    expect(a.flush()).toEqual(['It is short, and it stays whole'])
  })

  it.each([
    ['en-US', 'about 14,000,000 people live in the city', '14,000,000'],
    ['de-DE', 'wird es morgen etwa 3,5 Grad kalt', '3,5 Grad']
  ] as const)('keeps a number with a comma in it whole when a long %s sentence is cut at a clause', (locale, rest, number) => {
    const a = new SegmentAssembler(locale)
    const long = Array(25).fill('word').join(' ')
    const pieces = [...a.push(`${long} ${rest}, and that is all. `).sentences, ...a.flush()]
    expect(pieces.some((piece) => piece.includes(number))).toBe(true)
  })

  it('waits for the character after a comma at the end of a delta before cutting there', () => {
    const a = new SegmentAssembler('en-US')
    const long = Array(25).fill('word').join(' ')
    expect(a.push(`${long} about 14,`).sentences).toEqual([])
    expect(a.push('000 people, and').sentences).toEqual([`${long} about 14,000 people,`])
    expect(a.flush()).toEqual(['and'])
  })

  it('collapses runs of markdown marks and drops a piece with nothing to read', () => {
    const a = new SegmentAssembler('fr-FR')
    a.push('Un **titre** ici. ')
    expect(a.flush()).toEqual(['Un  titre  ici.'])
    a.push('-- ')
    expect(a.flush()).toEqual([])
  })
})

describe('SegmentAssembler across a pause in the text', () => {
  it('ends the sentence in progress at a pause, so the sentence said before a tool or a search is read while it runs', () => {
    const a = new SegmentAssembler('en-US')
    expect(a.push('Let me look that up.').sentences).toEqual([])
    expect(a.pause()).toEqual(['Let me look that up.'])
    expect(a.push('It will be sunny tomorrow.').sentences).toEqual([])
    expect(a.flush()).toEqual(['It will be sunny tomorrow.'])
  })

  it('puts a space between the text before a pause and the text after it where words are written apart', () => {
    const a = new SegmentAssembler('en-US')
    a.push('Let me look that up.')
    a.pause()
    expect(a.push('It will').text).toBe(' It will')
    expect(a.push(' be sunny.').text).toBe(' be sunny.')
  })

  it('adds no space where the text after the pause already starts with one, or nothing came before it', () => {
    const a = new SegmentAssembler('en-US')
    a.pause()
    expect(a.push('Sure.').text).toBe('Sure.')
    a.pause()
    expect(a.push('\n\nIt will be sunny.').text).toBe('\n\nIt will be sunny.')
  })

  it('joins Japanese across a pause as it is, since it writes words without spaces', () => {
    const a = new SegmentAssembler('ja-JP')
    expect(a.push('調べてみます').sentences).toEqual([])
    expect(a.pause()).toEqual(['調べてみます'])
    expect(a.push('明日は晴れです。')).toEqual({ text: '明日は晴れです。', sentences: ['明日は晴れです。'] })
  })
})
