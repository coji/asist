import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { writeFileAtomicSync } from './atomic-json'

/**
 * Reads and writes the JSON and JSONL files under userData, such as the jobs and the measurements. The
 * conversation log and the memory have their own stores in conversation-log and memory-store. A job's
 * log holds the agent's whole output, so every file is created readable by the user alone.
 */

const FILE_MODE = { mode: 0o600 }

export const dataPath = (...parts: string[]): string =>
  path.join(app.getPath('userData'), ...parts)

export function writeJson(name: string, value: unknown): void {
  writeFileAtomicSync(dataPath(name), JSON.stringify(value))
}

export function appendJsonl(name: string, value: unknown): void {
  const file = dataPath(name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(value) + '\n', FILE_MODE)
}

/** Reads the last maxLines lines, skipping any line that does not parse. */
export function readJsonl<T>(name: string, maxLines = Infinity): T[] {
  try {
    const lines = fs.readFileSync(dataPath(name), 'utf8').split('\n').filter(Boolean)
    const slice = lines.length > maxLines ? lines.slice(-maxLines) : lines
    const out: T[] = []
    for (const line of slice) {
      try {
        out.push(JSON.parse(line) as T)
      } catch {
        // The line does not parse and is skipped.
      }
    }
    return out
  } catch {
    return []
  }
}

export function removeData(name: string): void {
  fs.rmSync(dataPath(name), { force: true })
}
