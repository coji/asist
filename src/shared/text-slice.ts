/**
 * Part of a text, with `start` and `end` counted in code points where String.prototype.slice counts
 * UTF-16 units. A cut between units can leave half of a surrogate pair, which a strict JSON parser
 * refuses (Anthropic answers 400) and the aizuchi classifier's tokenizer rejects.
 */
export const sliceCodePoints = (text: string, start: number, end?: number): string => Array.from(text).slice(start, end).join('')
