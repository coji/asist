import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** What Git leaves out of a worktree and the checks need. */
const DEPENDENCIES = ['node_modules', path.join('resources', 'git'), path.join('resources', 'uv')]

/** The main checkout, also when this runs from inside another worktree. */
export function mainCheckout() {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
  return path.dirname(common)
}

/**
 * Copies the dependencies of the main checkout into a worktree and returns the ones the main checkout does
 * not have. On macOS cp -c clones on APFS, so each copy takes seconds and no extra space. On Windows
 * robocopy copies with several threads; fs.cpSync is not used there, because Node 22's crashes with an
 * access violation on a folder whose path holds non-ASCII characters.
 */
export function copyDependencies(root, dir) {
  const missing = []
  for (const dep of DEPENDENCIES) {
    const from = path.join(root, dep)
    const to = path.join(dir, dep)
    if (!fs.existsSync(from)) {
      missing.push(dep)
      continue
    }
    if (process.platform === 'darwin') {
      execFileSync('cp', ['-cR', from, to], { stdio: 'inherit' })
    } else if (process.platform === 'win32') {
      robocopy(from, to)
    } else {
      throw new Error(`worktree の依存を写す方法がこの OS(${process.platform})にはありません`)
    }
  }
  return missing
}

/** robocopy reports success with exit codes below 8, which execFileSync would take for failures. */
function robocopy(from, to) {
  try {
    execFileSync('robocopy', [from, to, '/E', '/MT:16', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'inherit', windowsHide: true })
  } catch (error) {
    if (typeof error.status !== 'number' || error.status >= 8) throw error
  }
}
