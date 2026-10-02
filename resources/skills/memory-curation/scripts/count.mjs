#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { PROMPT_DOCUMENTS, PROMPT_DOCUMENT_MAX_TOKENS, promptSize, textForTokens } from '../../memory-format.mjs'

// Counts what each file that goes into every conversation costs there, against its limit.
// Usage: node count.mjs <memoryDir>
// Prints one line per file and the exit code is 1 when a file is over its limit. The count is the one ASIST
// makes before it merges a curation and when the user saves on the memory screen, from memory-format.mjs.
// The English skill ships the same script with its lines written in English.

const dir = path.resolve(process.argv[2] ?? '.')
let over = false

for (const { file } of PROMPT_DOCUMENTS) {
  const full = path.join(dir, file)
  if (!fs.existsSync(full)) {
    console.log(`${file}: ありません`)
    continue
  }
  const size = promptSize(fs.readFileSync(full, 'utf8'))
  const left = PROMPT_DOCUMENT_MAX_TOKENS - size.tokens
  const counted = `${file}: ${size.tokens} / ${PROMPT_DOCUMENT_MAX_TOKENS} トークン`
  if (left >= 0) {
    console.log(`${counted}(残り ${left}。この書きぶりで約 ${textForTokens(size, left).characters} 字)`)
  } else {
    over = true
    console.log(`${counted}(${-left} 超過。この書きぶりで約 ${textForTokens(size, -left).characters} 字を削る)`)
  }
}

if (over) {
  console.log('超えているファイルを縮めて、もう一度実行してください。')
  process.exit(1)
}
console.log('OK')
