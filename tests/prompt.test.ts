import { describe, expect, it } from 'vitest'
import { journalHeading, marker } from '@shared/conversation-markers'
import { FIXED, embeddingTextOf } from '@shared/memory-page'
import { baseSystem, buildLiveSystemInstruction, buildSystemLayers, stampUserMessage } from '../src/main/services/brain/prompt'

const BASE_SYSTEM = baseSystem('ja-JP', 'self')
const DELEGATED_SYSTEM = baseSystem('ja-JP', 'delegated')

describe('buildSystemLayers', () => {
  it('builds the base layer alone for the smallest input', () => {
    const blocks = buildSystemLayers({ locale: 'ja-JP', persona: '', memoryBlock: null, historySummary: '' })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe(BASE_SYSTEM)
  })

  it('names the layers base, memory and summary, in the order of how rarely they change', () => {
    const layers = buildSystemLayers({
      locale: 'ja-JP',
      persona: '執事風',
      memoryBlock: '# 記憶\n- x',
      historySummary: '要約'
    })
    // The prompt cache up to a layer is readable only while the layers before it stay identical, so the more volatile a layer is, the later it goes.
    expect(layers.map((layer) => layer.name)).toEqual(['base', 'memory', 'summary'])
  })

  it('appends the persona to the same cached block as the base prompt', () => {
    const blocks = buildSystemLayers({ locale: 'ja-JP', persona: ' 執事風 ', memoryBlock: null, historySummary: '' })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toContain('# キャラクター設定\n執事風')
  })

  it('orders the blocks that follow as memory and summary', () => {
    const blocks = buildSystemLayers({
      locale: 'ja-JP',
      persona: '',
      memoryBlock: 'MEMORY',
      historySummary: 'SUMMARY'
    })
    expect(blocks).toHaveLength(3)
    expect(blocks[1].text).toBe('MEMORY')
    expect(blocks[2].text).toContain('SUMMARY')
  })

  it('carries no current-time block in the system prompt, because the stamp on the user message holds the time', () => {
    const blocks = buildSystemLayers({ locale: 'ja-JP', persona: '', memoryBlock: 'M', historySummary: 'S' })
    for (const block of blocks.slice(1)) expect(block.text).not.toContain('現在日時')
  })

  it('keeps the tool instructions out of the base prompt and puts the guide generated from the registry at the end of the unchanging layer', () => {
    const guide = '# ツールの使い分け\n- run_agent_task: 作業'
    const blocks = buildSystemLayers({ locale: 'ja-JP', persona: '執事風', toolGuide: guide, memoryBlock: 'M', historySummary: '' })
    expect(blocks[0].text.endsWith(guide)).toBe(true)
    expect(blocks[0].text.indexOf('# キャラクター設定')).toBeLessThan(blocks[0].text.indexOf('# ツールの使い分け'))
    expect(blocks[1].text).toBe('M')
  })
})

describe('stampUserMessage', () => {
  it('prefixes the message with the year, the month, the day, the weekday and the time', () => {
    const stamped = stampUserMessage('ja-JP', 'おはよう', new Date(2026, 6, 29, 9, 5))
    expect(stamped).toBe('[2026/7/29(水) 09:05] おはよう')
  })

  it('writes the weekday and the zero padding correctly', () => {
    expect(stampUserMessage('ja-JP', 'x', new Date(2026, 11, 6, 23, 59))).toBe('[2026/12/6(日) 23:59] x')
  })
})

describe('the base prompt with and without a separate voice', () => {
  it('gives delegated the section about splitting the work, and neither the bridge section nor the aizuchi constraint', () => {
    expect(DELEGATED_SYSTEM).toContain('# 声の担当との分担')
    expect(DELEGATED_SYSTEM).not.toContain('# つなぎ文')
    expect(DELEGATED_SYSTEM).not.toContain('直前に相槌')
    expect(BASE_SYSTEM).toContain('# つなぎ文')
    expect(BASE_SYSTEM).toContain('直前に相槌')
  })

  it('keeps the speaking style of self for live and drops the bridge section alone', () => {
    const live = baseSystem('ja-JP', 'live')
    expect(live).not.toContain('# つなぎ文')
    expect(live).not.toContain('# 声の担当との分担')
    expect(live).toContain('応答のアーク')
    expect(live).toContain('直前に相槌')
  })

  it('builds the Live system instruction as a single text that forbids announcing a function call and sets the tone, without example lines', () => {
    const text = buildLiveSystemInstruction({
      locale: 'ja-JP',
      persona: 'PERSONA-TEXT',
      memoryBlock: 'MEMORY-BLOCK',
      historySummary: 'S',
      jobContext: 'JOB-STATUS',
      startedAt: new Date(2026, 8, 16, 9, 5)
    })
    expect(text).toContain('# 音声での会話(Live)')
    expect(text).toContain('[2026/9/16(水) 09:05]')
    expect(text).toContain('呼ぶ前に予告や前置きを言わない')
    expect(text).toContain('ユーザーは日本語で話す')
    // A filler such as "見てみますね" appears neither as an example nor as a counter-example, because the model reuses the wording either way.
    expect(text).not.toContain('見てみますね')
    expect(text).toContain('丁寧語や決まり文句の癖より優先する')
    expect(text).not.toContain('# 話し方の例')
    expect(text).not.toContain('# つなぎ文')
    expect(text.indexOf('MEMORY-BLOCK')).toBeGreaterThan(text.indexOf('PERSONA-TEXT'))
    // A Live session reads its instruction once when it opens, so the job status as of then goes there.
    expect(text.indexOf('JOB-STATUS')).toBeGreaterThan(text.indexOf('MEMORY-BLOCK'))
  })
})

/**
 * One English prompt serves the ten languages that are not Japanese, so it has to name the language it
 * speaks and must carry no Japanese of its own: a stray Japanese line would be read as an instruction
 * to answer in Japanese.
 */
describe('the prompt of a conversation that is not held in Japanese', () => {
  const JAPANESE = /[぀-ヿ一-鿿]/

  it('names the conversation language in every layer that speaks to the model, and carries no Japanese', () => {
    for (const [locale, language] of [
      ['en-US', 'English'],
      ['ko-KR', 'Korean']
    ] as const) {
      for (const layer of ['self', 'delegated', 'live'] as const) {
        const prompt = baseSystem(locale, layer)
        expect(prompt).toContain(`The user speaks ${language}`)
        expect(prompt).not.toMatch(JAPANESE)
      }
      const live = buildLiveSystemInstruction({
        locale,
        persona: '',
        memoryBlock: null,
        historySummary: '',
        jobContext: null,
        startedAt: new Date(2026, 8, 16, 9, 5)
      })
      expect(live).toContain(`The user speaks ${language}. Listen and answer in ${language}`)
      expect(live).not.toMatch(JAPANESE)
    }
  })

  it('leaves out the backchannel guidance instead of translating it, because no other language plays one', () => {
    const limits = (prompt: string): string => prompt.slice(prompt.lastIndexOf('\n\n# '))
    // The only thing the Japanese limits add when the assistant speaks for itself is the line asking it
    // to carry on from the backchannel that has just played. Without backchannels there is nothing to
    // carry on from, so the two read the same.
    expect(limits(baseSystem('ja-JP', 'self'))).not.toBe(limits(baseSystem('ja-JP', 'delegated')))
    expect(limits(baseSystem('en-US', 'self'))).toBe(limits(baseSystem('en-US', 'delegated')))
    // The bridge sentence is not a backchannel: it says what a slow call is about to do, and it stays.
    expect(baseSystem('en-US', 'self')).toContain('# The bridge sentence')
  })

  it('explains the markers it is shown with the same text the app puts in front of them', () => {
    const prompt = baseSystem('en-US', 'self')
    expect(prompt).toContain(`"${marker('en-US', 'typedInputNote')}"`)
    expect(prompt).toContain(`"${marker('en-US', 'systemNotice')}"`)
    expect(prompt).toContain(`"${marker('en-US', 'memory')}"`)
    expect(prompt).toContain(`"${marker('en-US', 'jobStatus')}"`)
    expect(baseSystem('ja-JP', 'self')).toContain(`「${marker('ja-JP', 'jobStatus')}」`)
    expect(prompt).toContain(`"${journalHeading('en-US', '2026-09-07')}"`)
    // The heading is named for the model out of the same table the curation writes it from.
    expect(prompt).toContain(`"## ${FIXED.impression.en}"`)
    expect(baseSystem('ja-JP', 'self')).toContain(`「## ${FIXED.impression.ja}」`)
    // The stamp in the prompt is the one stampUserMessage writes, so the example cannot go stale.
    expect(prompt).toContain(`"${stampUserMessage('en-US', '', new Date(2025, 6, 29, 14, 32)).trim()}"`)
  })

  /**
   * The heading the note carries and the words the search index embedded a journal entry under have to
   * be the same, or the model is shown an entry under a name no search of its own would find.
   */
  it('heads an injected journal entry with the same words the index embedded it under', () => {
    for (const locale of ['ja-JP', 'en-US'] as const) {
      const heading = journalHeading(locale, '2026-09-07')
      const embedded = embeddingTextOf({ kind: 'journal', page: '2026-09-07', heading: 'h', text: locale === 'ja-JP' ? 'あ' : 'a', date: '2026-09-07' })
      expect(embedded.startsWith(heading.slice(2))).toBe(true)
    }
  })

  it('stamps a user message with a date no reader can misread, and with weekday names of its own', () => {
    expect(stampUserMessage('en-US', 'good morning', new Date(2026, 6, 29, 9, 5))).toBe('[Wed 2026-07-29 09:05] good morning')
    expect(stampUserMessage('ko-KR', 'x', new Date(2026, 11, 6, 23, 59))).toBe('[Sun 2026-12-06 23:59] x')
  })
})
