import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { copyDependencies, mainCheckout } from './worktree-deps.mjs'

/*
 * Creates a worktree for a subagent at .claude/worktrees/<name> of the main checkout, on a new branch from
 * the base (origin/main by default), and copies into it what Git leaves out and the checks need:
 * node_modules, resources/git and resources/uv. Without resources/git about seventy tests that run git fail,
 * and an isolated subagent cannot copy it itself: the guard refuses a command that names git twice.
 * Usage: node skills/worktree-delegation/scripts/prepare-worktree.mjs <name> <branch> [base]
 * It prints the path of the worktree.
 */

const [name, branch, base = 'origin/main'] = process.argv.slice(2)
if (!name || !branch) {
  console.error('使い方: prepare-worktree.mjs <名前> <ブランチ> [基にするコミット]')
  process.exit(2)
}

const root = mainCheckout()
const dir = path.join(root, '.claude', 'worktrees', name)
if (fs.existsSync(dir)) {
  console.error(`${dir} はもうあります。別の名前にするか、先に片づけてください`)
  process.exit(1)
}
execFileSync('git', ['-C', root, 'fetch', '-q', 'origin'], { stdio: 'inherit' })
execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', branch, dir, base], { stdio: 'inherit' })
for (const missing of copyDependencies(root, dir)) {
  console.error(`${missing} が本体にないので写していません(npm ci や npm run build で作られます)`)
}
console.log(dir)
