import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * A new folder in the temporary folder, spelled with the names the disk stores, which is how git and ASIST
 * name a repository. On Windows %TEMP% can hold an 8.3 short name, as C:\Users\RUNNER~1 on the CI runner,
 * which fs.realpathSync keeps and only the native call expands to C:\Users\runneradmin.
 */
export function longTempFolder(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), prefix)))
}
