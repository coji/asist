---
name: pull-request
description: How a change reaches main in ASIST - cutting a branch, committing, opening a pull request from the template, reviewing it, following CI, reporting to the user, and cleaning up after the user squash-merges it. Use when starting a change while on main, when a unit of work is ready (コミットして、pushして、PRにして、プルリク作って、PR出して、レビューして、マージできる状態にして), when CI fails on a pull request, or after a pull request was merged. Do not use for handing work to a subagent (worktree-delegation) or for installing the app (install-mac-app on a Mac, install-windows-app on Windows).
---

# Pull requests

main always works. Every change, a one-line README fix included, reaches it through a pull request that
CI has checked, and the user merges it with a squash. An agent prepares the pull request and says it is
ready; it does not merge. The squash commit takes its subject from the pull request's title and its
message from the body, so the title and body are written for `git log` as much as for the reviewer.

## 1. Start on a branch

- Never commit on main. Cut a branch from the latest main: `git fetch origin` and
  `git switch -c <name> origin/main`. The name is English kebab-case and names the change
  (`bundle-uv-and-git`, `fix-zombie-group-stop`).
- A session the Claude Code desktop app runs in a worktree of its own already has a branch. Work on it.
- One branch holds one coherent unit: a feature, a fix, a refactor or a documentation change. When the
  work turns into a second unit, open the pull request for the first, then cut a new branch from main
  for the second. Two units in one pull request become one commit on main that cannot be reverted apart.

## 2. Commit and push

- Before committing code, run `npm run typecheck` and `npm test`, and `npm run build` when packaging,
  preload or build configuration changed (AGENTS.md).
- The subject is one English sentence in the imperative, without a prefix such as `feat:`. The body
  says what changed and why, in full sentences. A decision record goes into the same commit (`adr`).
- Push to the branch as you go: `git push -u origin <name>` the first time, `git push` afterwards.
- A subagent's branch is merged into this branch, not into main (`worktree-delegation`).

## 3. Open the pull request

Write the body to a file following `.github/pull_request_template.md`, then:

```bash
gh pr create --base main --title "<the subject>" --body-file <file>
```

- The title is the subject the squash commit will carry: one sentence, the same rules as a commit subject.
- The first part of the body is prose: what changed and why. When the branch has several commits, it
  covers all of them, because the squash commit keeps the body and none of the branch's messages.
- "Checks" says what you ran and what you saw, with numbers where there are some (tests passed, the
  installed app's log). "Not checked" names what nobody verified. Screens go in as images.
- In the Claude Code desktop app, follow the pull request with its PR tools after creating it.

## 4. Review

- Run the code review on the pull request (`/code-review` in Claude Code). Where it is not available,
  read `git diff origin/main...HEAD` yourself against AGENTS.md.
- Fix what holds up, commit, push. Say in the report what was found and what you left and why.

## 5. CI

- Wait for the checks: `gh pr checks <number> --watch`.
- On a failure, read the log (`gh run view <run-id> --log-failed`), fix it on the branch and push.
  Do not re-run a failed job until it happens to pass: a test that fails only sometimes is a defect in
  the test or the code, and gets fixed or reported.
- When a job did not start at all, for example because of the account's Actions billing, say so and list
  the local checks that stand in for it. The user decides whether to merge.

## 6. Hand over

Report in Japanese: the pull request's URL, what it changes, the checks and their results, what the
review found, and what was not checked. Then stop. The user merges with a squash. Merge yourself only
when the user tells you to merge that pull request, and never turn on auto-merge unless asked.

## 7. After the merge

```bash
git switch main
git pull --ff-only
git branch -D <name>
```

A squash merge makes the branch's commits unreachable from main, so `git branch -d` refuses; `-D` is
expected. GitHub deletes the remote branch on merge. To see the change in the installed app, install
from main (`install-mac-app` on a Mac, `install-windows-app` on Windows).
