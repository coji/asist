import { spawnSync } from 'node:child_process'
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
 * exited 0 and what it printed. The Python is one the machine running the tests has, such as the one CI sets
 * up; uv is not let download one, and the user's uv configuration is left out. The scripts print only to
 * standard output and exit 1 for a finding, so anything else (no uv, no Python, a traceback) throws with what
 * uv or Python said, rather than reading as a finding with no lines.
 */
export function runPython(script: string, args: string[]): { ok: boolean; output: string } {
  const env = { ...process.env, UV_NO_CONFIG: '1', UV_PYTHON_DOWNLOADS: 'never', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' }
  const run = spawnSync(BUNDLED_UV, ['run', '--no-project', script, ...args], { encoding: 'utf8', env, windowsHide: true })
  if (run.error) throw run.error
  if (run.status === 0 || (run.status === 1 && !run.stderr)) return { ok: run.status === 0, output: run.stdout }
  throw new Error(`${path.basename(script)} exited with ${run.status}: ${run.stderr}`)
}
