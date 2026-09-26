import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { copyDependencies, mainCheckout } from './worktree-deps.mjs'

/*
 * Runs the tests a branch added or changed against the source of its base, to show that each test fails
 * without the fix. It checks the base out in a temporary worktree, puts the branch's version of every
 * added or changed file under tests/ into it, runs those test files, prints the failures and removes the
 * worktree. A test file that cannot even load on the base, because it imports something the branch added,
 * is listed as a failed file.
 * Usage: node skills/worktree-delegation/scripts/tests-on-base.mjs <branch> [base]
 */

const [branch, base = 'origin/main'] = process.argv.slice(2)
if (!branch) {
  console.error('使い方: tests-on-base.mjs <ブランチ> [基にするコミット]')
  process.exit(2)
}

const root = mainCheckout()
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
const files = git('diff', '--name-only', '--diff-filter=AM', `${base}...${branch}`, '--', 'tests/').split('\n').filter(Boolean)
if (files.length === 0) {
  console.error(`${branch} は tests/ の下を何も足しても変えてもいません`)
  process.exit(1)
}

const dir = path.join(root, '.claude', 'worktrees', `tests-on-base-${process.pid}`)
const cleanup = () => {
  try {
    execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', '--force', dir], { stdio: 'ignore' })
  } catch {
    // The worktree was never added, or is already gone.
  }
}
process.on('exit', cleanup)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130))

git('worktree', 'add', '-q', '--detach', dir, git('merge-base', base, branch).trim())
copyDependencies(root, dir)
for (const file of files) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), execFileSync('git', ['-C', root, 'show', `${branch}:${file}`]))
}

const tests = files.filter((file) => /\.test\.tsx?$/.test(file))
console.log(`基にしたコミット: ${git('rev-parse', '--short', base).trim()}、流すテスト: ${tests.join(' ')}`)
// The run is expected to fail, so its exit code is not this script's. vitest is run through node rather
// than npx, which is a .cmd on Windows and cannot be spawned without a shell.
const run = spawnSync(process.execPath, [path.join(dir, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...tests], {
  cwd: dir,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024
})
const output = `${run.stdout}${run.stderr}`
for (const line of output.split('\n')) {
  if (/^ (FAIL|✓|×)| Test Files | Tests /.test(line)) console.log(line)
}
