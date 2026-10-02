import { describe, expect, it } from 'vitest'
import { sliceCodePoints } from '@shared/text-slice'

describe('sliceCodePoints', () => {
  it('cuts between whole characters at either end, where a cut between UTF-16 units can leave half of a surrogate pair', () => {
    for (const text of ['😀'.repeat(10), `あ${'😀'.repeat(10)}`]) {
      for (let count = 1; count <= 11; count++) {
        expect(sliceCodePoints(text, -count).isWellFormed()).toBe(true)
        expect(sliceCodePoints(text, 0, count).isWellFormed()).toBe(true)
      }
    }
  })

  it('takes the same part of a text without surrogate pairs as slice does', () => {
    const text = '今日は晴れです。'
    for (const [start, end] of [[0, 3], [-3, undefined], [2, -2], [0, 100]] as const) {
      expect(sliceCodePoints(text, start, end)).toBe(text.slice(start, end))
    }
  })
})
