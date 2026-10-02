# One pull request per subagent

Read this when several independent pieces of work, such as the fixes for a list of bugs grouped by area,
each become a pull request of their own, handed to subagents that run at the same time. Everything
in SKILL.md still applies; this adds what running many of them in parallel needs.

## Group the work

- One pull request is one area whose files the others do not touch: mail, the calendar, the live
  engines, the settings screen. Two groups that edit the same file will conflict at merge; move the
  item, or say in both briefs which of them owns the file.
- Number the groups and merge them in that order. The user can then follow the order, and each later
  pull request is merged with main after the earlier ones are in.
- An item the user has to decide is asked before the brief goes out, not left to the subagent.
- Each group's pull request closes an issue of its own, on the board in 作業中 before its subagent starts
  (`project-board`). A list of fixes that belong together can be a parent issue with one sub-issue per
  group. A group that fixes a problem that must stay private has a draft card instead of an issue.

## Prepare each worktree yourself

```bash
node skills/worktree-delegation/scripts/prepare-worktree.mjs <name> <branch>
```

It adds `.claude/worktrees/<name>` on a new branch from origin/main and clones `node_modules`,
`resources/git` and `resources/uv` into it. Start the subagent without `isolation`, and give it the
printed path: it works through absolute paths or `(cd <path> && …)`. The Agent tool's own worktree has
none of these files, and a subagent that copies `resources/git` itself is refused by the guard; one that
rephrased the command to get past it lost its shell altogether.

## What the brief adds

Besides the template in `brief.md`:

- the worktree path and the branch, and that the three copied folders are not to be copied or
  re-created;
- that a refused command is never rephrased to get around the refusal: the step stops and the report
  says so;
- that it must not use `git stash`, `git checkout -- <path>` or `git reset`, which reach the other
  worktrees' stashes or throw work away;
- for an item that is only a suspicion, that it is confirmed by a reproduction, a measurement or a
  primary source before anything changes, and left with the evidence when it is not.

Rules shared by every brief can go into one file in the scratchpad that each brief tells the subagent
to read first.

## Take each result back

1. Read the report and the diff (`git -C <path> diff origin/main...HEAD`). Send what is wrong back to
   the same subagent with SendMessage, not to a new one, and do not finish its work yourself.
2. Merge origin/main into its branch (`git -C <path> merge --no-edit origin/main`), then run
   `npm run typecheck`, `npx vitest run` and `npm run i18n -- check` there, and `npm run build` when
   the change calls for it.
3. Check that its tests fail without the fix:

   ```bash
   node skills/worktree-delegation/scripts/tests-on-base.mjs <branch>
   ```

   Every item should have at least one failing test. A test file that cannot load on the base counts,
   but a test that fails only because a function's signature changed does not.
4. Push and open the pull request (`pull-request` skill), with the body written from the report and
   ending with `Closes #<issue>` (nothing for a draft card), and move the card to レビュー・CI.
5. Have it reviewed by another subagent that only reads (below). Send the findings that hold to the
   subagent that made the change, then push its fixes and update the pull request's body.
6. Wait for CI with `gh pr checks <number> --watch`, run in the background so the conversation goes on.
7. Merge in the numbered order. Before each merge, merge the latest main into the branch again and run
   the checks, because the pull request merged before it may touch the same files. A trial merge of the
   next branches into a scratch worktree shows those conflicts before they block the queue.
8. After the merge, remove the worktree and the branch (`git worktree remove --force --force <path>`,
   `git branch -D <branch>`).

## The reviewer's brief

```text
You are reviewing pull request <url> for real bugs. This is a read-only review: do not edit, commit,
push or run anything that changes files. The branch is checked out in <worktree>; get the diff with
git -C <worktree> diff origin/main...HEAD, and read AGENTS.md there.

Read every hunk and the code around it. Look for <what this change could break: races, a path that
still does the old thing, callers of a changed function, stored data from before the change>.

Prefer real failure modes over style; every finding needs a concrete scenario. You may confirm a
suspicion with a throwaway test under <scratchpad>/review<N>/, never inside the worktree. If a command
is refused, skip that step.

Report at most 15 findings, most severe first: file:line, severity, the defect in one sentence, the
scenario, and whether you confirmed it by running something or only by reading.
```
