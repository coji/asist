import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { PROMPT_DOCUMENT_MAX_TOKENS, SECTION_MAX_CHARS, tokenEstimate } from '@shared/memory-format'

/**
 * Sections that each stay within the cap of a page's section and together pass the token limit of a document
 * that goes into every prompt, built from one sentence, so that only that limit can refuse them.
 */
export function sectionsOverTheLimit(sentence: string): string {
  const text = sentence.repeat(Math.floor(SECTION_MAX_CHARS / Array.from(sentence.replace(/\s+/gu, '')).length))
  const sections: string[] = []
  while (tokenEstimate(sections.join('\n\n')) <= PROMPT_DOCUMENT_MAX_TOKENS) sections.push(`## 話題${sections.length + 1}\n${text}`)
  return sections.join('\n\n')
}

/** The uv the app ships, which prepare-resources puts in resources/uv before the tests run. */
export const BUNDLED_UV = path.join(process.cwd(), 'resources', 'uv', process.platform === 'win32' ? 'uv.exe' : 'uv')

/**
 * Runs a Python script through the bundled uv, as the curation Agent runs its checks, and returns whether it
 * exited 0 and what it printed. The Python is whichever uv finds on the machine running the tests; the user's
 * uv configuration is left out, and no bytecode is written beside the scripts.
 */
export function runPython(script: string, args: string[]): { ok: boolean; output: string } {
  const env = { ...process.env, UV_NO_CONFIG: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' }
  try {
    return { ok: true, output: execFileSync(BUNDLED_UV, ['run', '--no-project', script, ...args], { encoding: 'utf8', env, windowsHide: true }) }
  } catch (error) {
    return { ok: false, output: String((error as { stdout?: string }).stdout ?? '') }
  }
}
