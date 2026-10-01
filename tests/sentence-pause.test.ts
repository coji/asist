import { describe, expect, it } from 'vitest'
import { pauseAfter } from '../src/renderer/src/voice/sentence-pause'

describe('the pause after a piece of an answer', () => {
  it('is shorter after a piece cut at a comma than after one that ends a sentence', () => {
    expect(pauseAfter('長い文の途中で、')).toBeLessThan(pauseAfter('文の終わり。'))
    expect(pauseAfter('A long clause,')).toBeLessThan(pauseAfter('A sentence.'))
  })

  it('reads the end of a sentence through a closing quote or bracket', () => {
    expect(pauseAfter('「そうですね。」')).toBe(pauseAfter('そうですね。'))
    expect(pauseAfter('(たとえば、)')).toBe(pauseAfter('たとえば、'))
  })

  it('treats a piece without punctuation as the end of a sentence, as a line of a list ends', () => {
    expect(pauseAfter('牛乳')).toBe(pauseAfter('牛乳を買う。'))
  })
})
