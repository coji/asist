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
 * not have. On macOS cp -c clones on APFS, so each copy takes seconds and no extra space; fs.cpSync would
 * write every byte of node_modules again.
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
    } else {
      fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true })
    }
  }
  return missing
}
