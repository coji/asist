import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { documentIssues, isJournalName, pageNameIssue, promptSize, tokenEstimate, type DocumentKind } from '@shared/memory-format'
import CASES from './fixtures/memory-format-cases.json'
import { runPython } from './helpers/memory'

/**
 * ASIST checks the memory in TypeScript and the curation Agent in Python, run through the uv ASIST ships; a
 * curation the Agent's checks pass must never be refused at the merge, so both answer the same cases.
 */
describe('the rules of the memory in TypeScript and in the curation Python', () => {
  it('answers every shared case in TypeScript as the fixture expects', () => {
    for (const { name, text, tokens } of CASES.tokens) expect([name, tokenEstimate(text)]).toEqual([name, tokens])
    for (const { name, markdown, size } of CASES.prompts) expect([name, promptSize(markdown)]).toEqual([name, size])
    for (const { name, kind, markdown, issues } of CASES.documents) {
      expect([name, documentIssues(kind as DocumentKind, markdown)]).toEqual([name, issues])
    }
    for (const { name, issue } of CASES.pageNames) expect([name, pageNameIssue(name)]).toEqual([name, issue])
    for (const { name, valid } of CASES.journalNames) expect([name, isJournalName(name)]).toEqual([name, valid])
  })

  it('answers every shared case the same in the Python of the curation skills', () => {
    const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'memory-format-cases.json')
    const checker = path.join(process.cwd(), 'tests', 'helpers', 'memory_format_cases.py')
    const { ok, output } = runPython(checker, [fixture, path.join(process.cwd(), 'resources', 'skills')])
    expect(ok).toBe(true)
    expect(JSON.parse(output)).toEqual([])
  })
})
