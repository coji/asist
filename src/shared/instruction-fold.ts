import { SUMMARY_HEADING, bodyStart, writtenInJapanese } from './memory-format'
import { FIXED } from './memory-page'

/**
 * Where what an instruction.md held goes, now that me.md and user.md ride in every turn and it does not. The
 * fold moves its lines as they are, blank lines, line breaks and `# ` lines inside its sections included, and
 * leaves out only its own `# ` name. A section is the place the lines go to, never something rewritten.
 */

/** me.md and user.md as they are, null for one that does not exist. */
export interface PromptDocuments {
  me: string | null
  user: string | null
}

/**
 * A run of a document's lines, from `start` up to `end`: the lines above the first `## ` heading, whose
 * heading is null, or a `## ` heading with the lines under it. A `## ` line inside a fenced code block stays in
 * the block, so that the fold never cuts a fence in two.
 */
interface Block {
  heading: string | null
  start: number
  end: number
}

function blocksOf(lines: string[]): Block[] {
  const from = bodyStart(lines)
  const blocks: Block[] = [{ heading: null, start: from, end: lines.length }]
  let fence: string | null = null
  for (let i = from; i < lines.length; i++) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i])?.[1]
    if (marker && fence === null) fence = marker
    else if (marker && fence !== null && marker[0] === fence[0] && marker.length >= fence.length) fence = null
    else if (fence === null && /^## /.test(lines[i])) {
      blocks[blocks.length - 1].end = i
      blocks.push({ heading: lines[i].slice(3).trim(), start: i, end: lines.length })
    }
  }
  return blocks
}

/** The lines without the blank ones at either end. */
function trimBlank(lines: readonly string[]): string[] {
  let from = 0
  let to = lines.length
  while (from < to && !lines[from].trim()) from++
  while (to > from && !lines[to - 1].trim()) to--
  return lines.slice(from, to)
}

/**
 * Whether a heading stands for a document's summary: the text above its first `## ` heading is read under the
 * summary heading, so a `## 要約` and that text are one section, and moving either beside the other would
 * make the heading stand twice.
 */
const isSummary = (heading: string | null): boolean => heading === null || heading === SUMMARY_HEADING.ja || heading === SUMMARY_HEADING.en

const aboutMe = (heading: string | null): boolean => heading === FIXED.me.ja || heading === FIXED.me.en

/**
 * The document with the lines added to the section they belong to: the summary to its summary, which is the
 * `## 要約` it has or else the text above its first heading, and any other section to the section of the same
 * heading, or to a new one at the end under `headingLine`. Lines the section already holds as they are, as
 * after a fold that stopped before its commit, are not added again.
 */
function moveInto(document: string, heading: string | null, headingLine: string, text: readonly string[]): string {
  const eol = document.includes('\r\n') ? '\r\n' : '\n'
  const lines = document.split(/\r?\n/)
  const blocks = blocksOf(lines)
  const target = isSummary(heading)
    ? (blocks.find((block) => block.heading !== null && isSummary(block.heading)) ?? blocks[0])
    : blocks.find((block) => block.heading === heading)
  if (!target) {
    let end = lines.length
    while (end > 0 && !lines[end - 1].trim()) end--
    lines.splice(end, lines.length - end, ...(end > 0 ? [''] : []), headingLine, ...text, '')
    return lines.join(eol)
  }
  if (lines.slice(target.start, target.end).join('\n').includes(text.join('\n'))) return document
  let end = target.end
  while (end > target.start && !lines[end - 1].trim()) end--
  const before = end > target.start ? [''] : []
  const after = end < lines.length && lines[end].trim() ? [''] : []
  lines.splice(end, 0, ...before, ...text, ...after)
  if (lines[lines.length - 1] !== '') lines.push('')
  return lines.join(eol)
}

/**
 * The instruction's section about the assistant goes into me.md and everything else into user.md, its summary
 * among them. A document that does not exist yet, or holds nothing but whitespace, is started under its name in
 * the form the instruction was written in. Folding the same instruction again changes nothing, so a fold that
 * stopped before its commit can run again. The next curation sorts the moved lines under the documents' own
 * headings.
 */
export function foldInstruction(instruction: string, documents: PromptDocuments, today: string): PromptDocuments {
  const lines = instruction.split(/\r?\n/)
  const blocks = blocksOf(lines)
  const form = writtenInJapanese(instruction) ? 'ja' : 'en'
  const folded = { ...documents }
  for (const target of ['me', 'user'] as const) {
    let document = documents[target]
    for (const block of blocks) {
      if (aboutMe(block.heading) !== (target === 'me')) continue
      const own = lines.slice(block.heading === null ? block.start : block.start + 1, block.end)
      // The instruction's own `# ` name is the name of a document that is going away.
      const name = block.heading === null ? own.findIndex((line) => /^# /.test(line)) : -1
      const text = trimBlank(name === -1 ? own : own.filter((_, index) => index !== name))
      if (text.length === 0) continue
      document = moveInto(document?.trim() ? document : `---\nupdated: ${today}\n---\n# ${FIXED[target][form]}\n`, block.heading, lines[block.start], text)
    }
    folded[target] = document
  }
  return folded
}
