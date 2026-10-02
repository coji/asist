# The brief for a subagent

Fill in every part. A subagent sees nothing of the conversation, so anything left out is guessed.

```text
You are working in the ASIST repository. Read AGENTS.md at the repo root first and follow it
(comment rules, the ui-text skill for any text the app shows or says, tests that protect behavior
rather than wording). Your git worktree is <absolute path>, on branch <branch>; work only there,
through absolute paths or (cd <path> && …). node_modules, resources/git and resources/uv are already
copied into it: never copy, move or re-create them.
[Or: You are in the main working tree, not a worktree. Do not commit.]

## Background
<What the user wants and why, in a few sentences. What has already been decided.>

## Task
<What to change, as outcomes rather than steps. What "done" looks like.>

## Scope
- You may touch: <files or directories>.
- Do not touch: <files another agent is changing at the same time, and why>.
- Skills to follow: <visual-debugging for screens, panel-card-design for cards, …>.

## Verify
- npm run typecheck and npm test.
- <Screens: capture with the visual-debugging scripts and look at the images yourself.>
- <Wording: npm run demo:fit.>
- Stop anything you start.

## How to work
Do all of the work yourself, in this worktree. Do not start other agents or background tasks: when
you reply, your task is over and nothing you started is waited for. Reply only once the work is
committed and the report below is complete.
If a command is refused, do not rephrase it to get around the refusal: stop that step and say so in
the report. Do not use git stash, git checkout -- <path> or git reset.

## Finish
Commit on your branch, with a message that follows AGENTS.md (one English sentence in the imperative,
then what changed and why). Do not push and do not merge. Do not open issues or pull requests and do
not touch the project board, even where a skill says to: the agent that briefed you does that.

## Report
The files changed with one line each, the root cause of each problem, the tests added,
the typecheck and test results, the paths of any screenshots, what you did not check,
any command that was refused, and the commit hash and branch name.
```
