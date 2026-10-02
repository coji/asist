import type { ConversationLocale } from './conversation-locale'

/**
 * Assembles the streaming text of a reply: it joins the deltas into the text the screen and the log show,
 * and cuts whole sentences out of it, so that each sentence can be sent to TTS as soon as it is complete.
 */

const SENTENCE_END = /[。!?！？\n]/
/** Runs of markdown marks would be read out, so they become a space. */
const MARKDOWN_RUN = /[*#`_>|-]{2,}/g

/**
 * A piece as it is read aloud, or null when it has nothing to read. Punctuation on its own, such as
 * the "？" a split leaves after "!", the "」" after "。" or the comma a cut leaves behind, carries no
 * letter or digit.
 */
function readable(piece: string): string | null {
  const text = piece.replace(MARKDOWN_RUN, ' ').trim()
  return /[\p{L}\p{N}]/u.test(text) ? text : null
}

interface Splitter {
  push(delta: string): string[]
  flush(): string[]
}

/** The sentences of a stream of text, in the rules of the language it is written in. */
export class SegmentAssembler {
  private readonly splitter: Splitter
  /** What goes between the text before a pause and the text after it. Japanese writes words without spaces. */
  private readonly gap: string
  private lastDelta = ''
  private paused = false

  constructor(locale: ConversationLocale) {
    const japanese = locale === 'ja-JP'
    this.splitter = japanese ? new JapaneseSplitter() : new IntlSplitter(locale)
    this.gap = japanese ? '' : ' '
  }

  /** Takes the next delta, and returns it as it joins the text before it, with the sentences it completes. */
  push(delta: string): { text: string; sentences: string[] } {
    const text = this.paused && /\S$/.test(this.lastDelta) && /^\S/.test(delta) ? `${this.gap}${delta}` : delta
    if (text) {
      this.lastDelta = text
      this.paused = false
    }
    return { text, sentences: this.splitter.push(text) }
  }

  /**
   * Ends the sentence in progress where the model's text stops for a while, as while its tools or a web
   * search run. The sentence said before the pause is complete, and holding it for the text
   * after it would keep it silent through the whole pause. A model starts the text after a pause without
   * a space, so the next delta gets one where words are written apart, rather than running on ("up.It").
   */
  pause(): string[] {
    this.paused = true
    return this.splitter.flush()
  }

  flush(): string[] {
    return this.splitter.flush()
  }
}

/** Japanese ends a sentence in one of a few characters, none of which appears inside a word or a number. */
class JapaneseSplitter implements Splitter {
  private sentence = ''

  push(delta: string): string[] {
    const out: string[] = []
    for (const char of delta) {
      this.sentence += char
      if (SENTENCE_END.test(char)) this.emit(out)
      else if (char === '、' && this.sentence.length > 50) this.emit(out)
    }
    return out
  }

  flush(): string[] {
    const out: string[] = []
    this.emit(out)
    return out
  }

  private emit(out: string[]): void {
    const text = readable(this.sentence)
    if (text) out.push(text)
    this.sentence = ''
  }
}

/**
 * The other languages end a sentence in `.`, which also stands inside a decimal (3.5) and after an
 * abbreviation, so the sentences come from Intl.Segmenter rather than from a rule over characters.
 *
 * The segmenter reports the end of the text as the end of a sentence even while the model is still
 * writing it, and the characters after a `.` are what decide whether that `.` ended the sentence, so
 * the last piece is held back until more text arrives or the stream ends. V8's segmenter has no list
 * of abbreviations (checked on 2026-09-22; the `-u-ss-standard` keyword is dropped), so "z. B." is
 * read as two sentences. They are still read in order, one after the other.
 */
class IntlSplitter implements Splitter {
  private pending = ''
  private readonly sentences: Intl.Segmenter
  private readonly words: Intl.Segmenter

  constructor(locale: ConversationLocale) {
    this.sentences = new Intl.Segmenter(locale, { granularity: 'sentence' })
    this.words = new Intl.Segmenter(locale, { granularity: 'word' })
  }

  push(delta: string): string[] {
    this.pending += delta
    const out: string[] = []
    const parts = [...this.sentences.segment(this.pending)].map((part) => part.segment)
    this.pending = parts.pop() ?? ''
    for (const part of parts) this.emit(part, out)
    for (let cut = this.clauseCut(); cut > 0; cut = this.clauseCut()) {
      this.emit(this.pending.slice(0, cut), out)
      this.pending = this.pending.slice(cut)
    }
    return out
  }

  flush(): string[] {
    const out: string[] = []
    this.emit(this.pending, out)
    this.pending = ''
    return out
  }

  /**
   * Where to cut a sentence that has grown too long to wait for, or 0. Speech starts sooner when a
   * long sentence is read in clauses, and a clause boundary is the only place a cut is not heard as
   * an interruption. The limit is in words because a character means far less here than in Japanese:
   * 20 words at 150 words a minute is eight seconds, about what the 50 characters of Japanese are. A
   * clause ends only where the comma or semicolon ends a word: one with a digit after it is inside a
   * number (14,000,000, or 3,5 in German), and one at the end of the text waits for what follows.
   */
  private clauseCut(): number {
    for (const match of this.pending.matchAll(/[,;](?=\s)/g)) {
      const end = match.index + 1
      if (this.wordCount(this.pending.slice(0, end)) > 20) return end
    }
    return 0
  }

  private wordCount(text: string): number {
    let count = 0
    for (const word of this.words.segment(text)) if (word.isWordLike) count++
    return count
  }

  private emit(piece: string, out: string[]): void {
    const text = readable(piece)
    if (text) out.push(text)
  }
}
