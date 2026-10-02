---
name: worktree-delegation
description: How to hand part of the ASIST work to a subagent in a git worktree prepared with the dependencies it needs, and take the result back - into the branch of your pull request, or as a pull request of its own when several subagents fix separate areas at once - deciding what to hand over, writing the brief, reviewing the diff, checking its tests fail without the fix, merging in order, and removing the worktrees afterwards. Use when the user asks to delegate or parallelize work (subagentに任せて、worktreeで、並行して進めて、別のAgentに調べさせて、まとめて直して、エリアごとにPR), when you decide to split a task across agents yourself, or when a subagent's branch is waiting to be merged or a leftover worktree needs cleaning up. Do not use for a quick read-only search you can run yourself.
---

# Handing work to a subagent

A subagent works best on a task whose files do not overlap with yours. Everything below exists to keep
two sets of changes from colliding, and to make sure what reaches your branch is something you have read.

## 1. Decide whether to hand it over

- Hand over a task whose files you will not touch while it runs, such as skills while you change `src/`,
  or a bug in one screen while you build another.
- Keep a task yourself when it edits the files you are editing now, or when it cannot be described
  without the decisions you are still making.
- A read-only investigation (prices, library comparisons) needs no worktree; start it without isolation.

## 2. Decide where it works

- **A worktree you prepare** is the default:

  ```bash
  node skills/worktree-delegation/scripts/prepare-worktree.mjs <name> <branch> [base]
  ```

  It adds `.claude/worktrees/<name>` on a new branch from the base (origin/main unless given) and copies
  `node_modules`, `resources/git` and `resources/uv` into it (a clone on macOS, a full copy elsewhere),
  which Git leaves out and the checks need:
  without `resources/git` about seventy tests fail. Start the subagent without `isolation` and give it
  the printed path. The Agent tool's own `isolation: "worktree"` has none of these files, and a subagent
  that copies `resources/git` itself is refused by the guard, so leave that only for a task that runs no
  checks. A worktree starts from a commit, not from your working tree, so commit anything it must see
  first.
- **The main working tree, without a worktree**, only when the task depends on your uncommitted changes
  (updating the tests for the change you just made). Then name exactly which files are its own and which
  are yours, tell it not to commit, and do not touch its files until it reports.
- **Several subagents, each with a pull request of its own** (a list of fixes grouped by area): follow
  `references/parallel-pull-requests.md` for grouping, the order of merging, the review and CI.

## 3. Write the brief

Use the template in `references/brief.md`. A subagent has none of this conversation, so the brief carries
the background, the files it may touch, what to read first (AGENTS.md and the skills that apply), how to
verify, that it commits on its own branch and never pushes or merges, and the shape of its report. Tell
it which files another agent is changing at the same time. Keep the template's "How to work" part: a
subagent that splits its task into agents of its own and replies "waiting for them" stops there, because
nothing reaches it after it replies, and leaves its changes uncommitted. Keep its rule on refused
commands as well: a subagent that rephrases a refused command to get past the guard does what the user's
permissions refused, and one that did so lost its shell for the rest of its task.

## 4. While it runs

- Keep working on your own files. Tell the user in one line what you handed over.
- The subagent neither opens issues nor touches the project board; the brief says so. You give its
  work an issue before it starts and move the card as its pull request opens, or to 判断待ち when its
  report leaves the user a decision (`project-board`).
- Do not run a long check such as `npm run demo:fit` while you are merging or while files it reads are
  changing; the demo reloads under it and the run fails for no reason in the code.
- Never `cd` into a worktree. In Claude Code that moves the session's working directory there. Read its
  files by absolute path, run git with `git -C <path>`, and run npm in a subshell, `(cd <path> && npm …)`.
- When a subagent reports a refused command, do the step yourself only if this skill gives it to you,
  such as copying the dependencies. Anything else goes to the user.

## 5. Take the result back

1. If it replied without a commit or without the report, check `git -C <path> status` and
   `git -C <path> log <your branch>..HEAD`, then resume the same agent (SendMessage to its id) and ask it to finish
   and commit. Do not finish its work yourself in its worktree.
2. Read its report, then read the diff yourself: `git diff <your branch>...<branch> --stat` and the parts that
   matter. Check that the diff is what the report says. Do not pass a report on to the user unread.
   For a fix, check that its tests fail without it:
   `node skills/worktree-delegation/scripts/tests-on-base.mjs <branch>` runs the tests the branch added or
   changed against the source of its base, in a temporary worktree it removes afterwards.
3. On the branch of your pull request, never on main: if its files overlap with your uncommitted
   changes, commit yours first, then `git merge --no-edit <branch>`. Resolve any conflict by hand. The
   merge commit disappears when the pull request is squashed.
4. Run `npm run typecheck` and `npm test` on the merged tree. Run `npm run build` or the screen checks
   when the change calls for them. Then push the branch; the pull request follows the `pull-request`
   skill.
5. Remove what it left: `git worktree remove --force <path>`, `git branch -d <branch>` (or `-D` when the
   branch was merged under another commit), and confirm with `git worktree list` and `git branch`.
   A branch you decide not to merge is removed the same way, after telling the user.

## 6. Report to the user

Say who did what, what was found (root causes, bugs it caught in your own change), what you took into
the branch and pushed, what nobody checked, and that the worktree is gone. Write it in Japanese.
