#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { PROMPT_DOCUMENTS, PROMPT_DOCUMENT_MAX_TOKENS, promptSize, textForTokens } from '../../memory-format.mjs'

// Counts what each file that goes into every conversation costs there, against its limit.
// Usage: node count.mjs <memoryDir>
// Prints one line per file and the exit code is 1 when a file is over its limit. The count is the one ASIST
// makes before it merges a curation and when the user saves on the memory screen, from memory-format.mjs.
// The Japanese skill ships the same script with its lines written in Japanese.

const dir = path.resolve(process.argv[2] ?? '.')
let over = false

/** An amount of the file's own text, in the units a writer of any of the languages can cut by. */
const amount = ({ characters, words }) => `about ${words} words (${characters} characters without spaces)`

for (const { file } of PROMPT_DOCUMENTS) {
  const full = path.join(dir, file)
  if (!fs.existsSync(full)) {
    console.log(`${file}: missing`)
    continue
  }
  const size = promptSize(fs.readFileSync(full, 'utf8'))
  const left = PROMPT_DOCUMENT_MAX_TOKENS - size.tokens
  const counted = `${file}: ${size.tokens} of ${PROMPT_DOCUMENT_MAX_TOKENS} tokens`
  if (left >= 0) {
    console.log(`${counted} (${left} left, ${amount(textForTokens(size, left))} as this file is written)`)
  } else {
    over = true
    console.log(`${counted} (${-left} over: cut ${amount(textForTokens(size, -left))} as this file is written)`)
  }
}

if (over) {
  console.log('Shorten the files that are over, then run this again.')
  process.exit(1)
}
console.log('OK')
