import { describe, expect, it } from 'vitest'
import {
  CURATION_SKILL,
  MEMORY_GITIGNORE,
  SKILL_DIRS,
  buildCurationPrompt,
  curationDue,
  curationSkillSource,
  hasUserSpeech,
  pendingDays,
  renderTranscript,
  worktreeAgentsMd
} from '@shared/memory-curation'

const T = new Date(2026, 8, 8, 10, 30).getTime()
const JAPANESE = /[぀-ヿ一-鿿]/

describe('renderTranscript', () => {
  it('prefixes every line with the time and the turn number, and tells speaker, notice and tool lines apart', () => {
    const text = renderTranscript(
      [
        { t: T, kind: 'user', turnId: 3, text: '松葉軒行ったんだけどさあ' },
        { t: T + 1000, kind: 'tool', turnId: 3, name: 'show_weather', input: '{"location":"東京"}' },
        { t: T + 2000, kind: 'assistant', turnId: 3, text: 'どうでした?' },
        { t: T + 3000, kind: 'notice', turnId: 4, text: '[システム通知] ジョブが完了した' },
        { t: T + 4000, kind: 'checkpoint' }
      ],
      'ja-JP'
    )
    expect(text).toBe(
      '[10:30 #3] ユーザー: 松葉軒行ったんだけどさあ\n[10:30 #3] (ツール show_weather {"location":"東京"})\n[10:30 #3] アシスタント: どうでした?\n[10:30 #4] (アプリの通知) [システム通知] ジョブが完了した'
    )
  })

  it('names the speakers in the language of the prompt when the conversation is not Japanese', () => {
    const text = renderTranscript(
      [
        { t: T, kind: 'user', turnId: 1, text: 'Ich war gestern im Museum' },
        { t: T + 1000, kind: 'assistant', turnId: 1, text: 'Wie war es?' },
        { t: T + 2000, kind: 'notice', turnId: 2, text: 'job done' },
        { t: T + 3000, kind: 'tool', turnId: 2, name: 'show_weather', input: '{}' }
      ],
      'de-DE'
    )
    expect(text).toBe(
      '[10:30 #1] User: Ich war gestern im Museum\n[10:30 #1] Assistant: Wie war es?\n[10:30 #2] (app notice) job done\n[10:30 #2] (tool show_weather {})'
    )
    expect(JAPANESE.test(text)).toBe(false)
  })
})

describe('hasUserSpeech', () => {
  it('reads from the records, not from the rendered text, so the language of the transcript does not decide it', () => {
    const records = [{ t: T, kind: 'assistant', text: 'Guten Morgen' }, { t: T + 1, kind: 'notice', text: 'job done' }]
    expect(hasUserSpeech(records)).toBe(false)
    expect(hasUserSpeech([...records, { t: T + 2, kind: 'user', text: 'Hallo' }])).toBe(true)
    expect(hasUserSpeech([{ t: T, kind: 'user', text: 'こんにちは' }])).toBe(true)
  })
})

describe('pendingDays', () => {
  const now = new Date(2026, 8, 9, 3, 0).getTime()
  const completed = (curatedThrough: string) => ({ curatedThrough, pendingFrom: null })
  it('returns the days from the stored start, or from the day after the last curated one, up to yesterday and at most seven', () => {
    expect(pendingDays({ curatedThrough: null, pendingFrom: '2026-09-08' }, now).map((d) => d.getDate())).toEqual([8])
    expect(pendingDays(completed('2026-09-05'), now).map((d) => d.getDate())).toEqual([6, 7, 8])
    expect(pendingDays(completed('2026-08-01'), now).map((d) => d.getDate())).toEqual([2, 3, 4, 5, 6, 7, 8])
    expect(pendingDays(completed('2026-09-08'), now)).toEqual([])
  })
  it('skips no old uncurated day after a long pause and catches up in order', () => {
    const first = pendingDays(completed('2026-08-01'), now)
    expect(first[0]).toEqual(new Date(2026, 7, 2))
    expect(first.at(-1)).toEqual(new Date(2026, 7, 8))
    const second = pendingDays(completed('2026-08-08'), now)
    expect(second[0]).toEqual(new Date(2026, 7, 9))
  })
  it('keeps counting from the stored start while the first run is unfinished, even once the date has changed', () => {
    expect(pendingDays({ curatedThrough: null, pendingFrom: '2026-09-06' }, now).map((d) => d.getDate())).toEqual([6, 7, 8])
    expect(() => pendingDays({ curatedThrough: null, pendingFrom: null }, now)).toThrow()
  })
})

describe('curationDue', () => {
  const at = (day: number, hour: number, minute = 0): number => new Date(2026, 8, day, hour, minute).getTime()

  it('is due right after midnight when yesterday is not curated yet', () => {
    expect(curationDue({ curatedThrough: '2026-09-07', lastFailureAt: null }, at(9, 0, 1))).toBe(true)
    expect(curationDue({ curatedThrough: '2026-08-01', lastFailureAt: null }, at(9, 0, 1))).toBe(true)
  })

  it('is due on the very first run, when nothing has been curated yet', () => {
    expect(curationDue({ curatedThrough: null, lastFailureAt: null }, at(9, 12))).toBe(true)
  })

  it('is not due once the days up to yesterday are curated', () => {
    expect(curationDue({ curatedThrough: '2026-09-08', lastFailureAt: null }, at(9, 0, 1))).toBe(false)
    expect(curationDue({ curatedThrough: '2026-09-08', lastFailureAt: null }, at(9, 23, 59))).toBe(false)
  })

  it('does not start again on the day a curation failed, and is due again on the next day', () => {
    const failed = { curatedThrough: '2026-09-07', lastFailureAt: at(9, 0, 2) }
    expect(curationDue(failed, at(9, 0, 3))).toBe(false)
    expect(curationDue(failed, at(9, 23, 59))).toBe(false)
    expect(curationDue(failed, at(10, 0, 1))).toBe(true)
  })

  it('does not hold back the curation for a failure recorded before today', () => {
    expect(curationDue({ curatedThrough: '2026-09-07', lastFailureAt: at(8, 23, 59) }, at(9, 0, 1))).toBe(true)
  })
})

describe('buildCurationPrompt', () => {
  it('orders the short instruction, the persona and the transcript of each day, and says so for a day without conversation', () => {
    const prompt = buildCurationPrompt({
      days: [
        { date: '2026-09-07', transcript: '[10:00 #1] ユーザー: こんにちは' },
        { date: '2026-09-08', transcript: '' }
      ],
      today: '2026-09-09',
      locale: 'ja-JP',
      persona: ' 執事風 '
    })
    expect(prompt.startsWith(`今日は 2026-09-09。\`${CURATION_SKILL}\` スキル`)).toBe(true)
    expect(prompt).toContain('# キャラクター設定(me.md、アシスタント自身の出発点)\n執事風')
    expect(prompt).toContain('# 2026-09-07 の会話\n[10:00 #1] ユーザー: こんにちは')
    expect(prompt.endsWith('# 2026-09-08 の会話\n(会話なし)')).toBe(true)
    expect(prompt.indexOf('キャラクター設定')).toBeLessThan(prompt.indexOf('# 2026-09-07 の会話'))
    expect(prompt).not.toContain('forget.jsonl')
    const bare = buildCurationPrompt({ days: [], today: '2026-09-09', locale: 'ja-JP' })
    expect(bare).not.toContain('キャラクター設定')
  })

  it('names the language of the conversation and the English headings, in English and with the same parts, for another language', () => {
    const prompt = buildCurationPrompt({
      days: [
        { date: '2026-09-07', transcript: '[10:00 #1] User: Guten Morgen' },
        { date: '2026-09-08', transcript: '' }
      ],
      today: '2026-09-09',
      locale: 'de-DE',
      persona: ' like a butler '
    })
    expect(prompt.startsWith(`Today is 2026-09-09. Follow the \`${CURATION_SKILL}\` skill`)).toBe(true)
    expect(prompt).toContain('write the body of every file in German')
    expect(prompt).toContain('"Summary"')
    expect(prompt).toContain('# Character settings (me.md, where the assistant starts from)\nlike a butler')
    expect(prompt).toContain('# The conversation of 2026-09-07\n[10:00 #1] User: Guten Morgen')
    expect(prompt.endsWith('# The conversation of 2026-09-08\n(no conversation)')).toBe(true)
    expect(prompt).not.toContain('forget.jsonl')
    expect(JAPANESE.test(prompt)).toBe(false)
    expect(buildCurationPrompt({ days: [], today: '2026-09-09', locale: 'ko-KR' })).toContain('in Korean')
  })
})

describe('what the worktree holds', () => {
  it('puts the skill in both the claude and the codex directory, tells AGENTS.md to always use it, and excludes all of them in .gitignore', () => {
    for (const locale of ['ja-JP', 'de-DE'] as const) {
      expect(worktreeAgentsMd(locale)).toContain(`.claude/skills/${CURATION_SKILL}`)
      expect(worktreeAgentsMd(locale)).toContain(`$${CURATION_SKILL}`)
    }
    expect(SKILL_DIRS).toEqual(['.claude/skills', '.agents/skills'])
    expect(worktreeAgentsMd('ja-JP')).toContain('git は操作しない')
    expect(worktreeAgentsMd('de-DE')).toContain('Do not run git')
    expect(JAPANESE.test(worktreeAgentsMd('de-DE'))).toBe(false)
    expect(MEMORY_GITIGNORE.split('\n')).toEqual(expect.arrayContaining(['.claude/', '.agents/', 'AGENTS.md']))
  })

  it('takes the Japanese skill for a Japanese conversation and the English one for every other language', () => {
    expect(curationSkillSource('ja-JP')).toBe(CURATION_SKILL)
    expect(curationSkillSource('en-US')).toBe(`${CURATION_SKILL}-en`)
    expect(curationSkillSource('hi-IN')).toBe(`${CURATION_SKILL}-en`)
  })
})
