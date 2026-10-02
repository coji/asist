---
title: Agent jobs
description: Hand research and file edits to the codex or claude CLI.
sidebar:
  order: 1
---

Research that takes a while and edits to files go to the codex or claude CLI as Agent jobs. Before you use them, follow [Setting up the Agent](/en/docs/start/agent-cli/).

![The Agent jobs screen, with the list of jobs and a log](/screens/en/agent.webp)

## Every job is confirmed first

Every job you ask for in the conversation, even one that only reads, shows a confirmation screen before it starts and before it continues. The screen shows the instructions for the agent, the working directory, and whether the job can write. The job starts only when you click "Start job". Speaking while the confirmation screen is open neither approves nor cancels it. Jobs run with your permissions, so cancel any job whose instructions you don't remember giving.

## Merging the changes

Edits to a Git repository are made in a separate worktree. When the job finishes, review the diff and choose "Merge" or "Discard". When you ask for a merge in the conversation, a confirmation screen lists the changes, and ASIST merges them only after you approve. When you ask in the conversation for the changes to be discarded, ASIST discards them only after you approve on a confirmation screen. Discarded changes cannot be restored.

When the working directory is a folder inside a repository, the job runs in the same folder of the worktree. That folder has to be committed to the repository: a job whose working directory is a folder that isn't committed does not start. Neither the commit that gathers a job's changes in the worktree nor the merge runs the repository's commit hooks (pre-commit, prepare-commit-msg, commit-msg, pre-merge-commit and post-commit). The commit holds the files of the worktree as they are on disk, including changes to files marked assume-unchanged or skip-worktree, and changes that the repository's core.ignoreStat, core.fsmonitor, core.checkStat or core.trustctime settings would keep git from seeing.

In a repository with a sparse checkout, files that are not checked out do not count as deleted, and files written outside the sparse checkout are included. A file that is marked skip-worktree and missing from the worktree, but that no sparse checkout leaves out (one inside the sparse checkout, or any file while sparse checkout is turned off), may have been deleted or never checked out, and there is no telling which: the changes are then not committed, the worktree stays, and the job's log gives the reason. The same happens when something stands where files that are not checked out belong, so that the commit would delete them.

Besides the settings for line endings and symbolic links, ASIST's git reads the list of ignored files you set with `core.excludesFile` in `~/.gitconfig`. A file you ignore in every repository, such as `.DS_Store`, is therefore ignored by the check before a merge and by the job's commit, as your own git ignores it.

A file written where the repository ignores files (such as `dist/` or `.env`) does not go into the commit, so it is not merged. When a file the agent reported writing lies in such a place, the job keeps its worktree and waits to be merged even if it changed nothing else, and the file is named as one that will not be merged, above the diff and on the confirmation screens for a merge and for a discard. A follow-up job that ends without writing anything keeps the worktree too while such a file from the job before it is there. The file is deleted with the worktree whether you merge or discard, so open it and move it elsewhere first if you need it. The output files of a job open from its card wherever they lie in the worktree, also outside the folder the job worked in. A merge never overwrites a file in your working tree that git does not track, an ignored `.env` included: when the job's commit brings in a file at such a place, the merge stops and names that file.

The diff you review shows only the job's own changes, even when the job merged your branch in or rebased onto it. A merge goes into the branch that was checked out in the repository when you reviewed the diff, and its name is shown above the diff and on the confirmation screen for a merge you ask for in the conversation. If you check out another branch after reviewing the diff, even one created from the same commit, or the commit the diff counts from changes (the one where the job's branch and the checked-out branch parted), the merge stops and shows the reason with the new diff. Nothing can be merged while the checked-out branch shares no history with the job, or while HEAD is not on a branch, as during a bisect.

ASIST does not merge a job that touched a submodule: one that changed the commit a submodule points to or .gitmodules, added or removed a submodule, initialized one, or committed or changed files inside one. Such a job keeps its worktree and waits, with the submodules, the branch and the location of the worktree shown above the diff. Commits made inside a submodule may exist only in the copy in that worktree, and then git submodule update in your checkout cannot fetch them. If needed, push them from the worktree, then merge the branch yourself, or discard the job. Discarding deletes that copy too, so when the worktree may hold work in a submodule, pressing "Discard" on the card also brings up a confirmation screen.

ASIST does not merge a job whose agent switched the worktree to a branch of its own, or renamed the job's branch, either, as it may when you ask it to create a branch and commit. ASIST commits nothing onto that branch, keeps the worktree and lets the job wait, with the name of the branch on the card. Merge the branch yourself, or discard the job. The agent's branch stays in the repository when you discard it.

In a repository that ASIST's git cannot open, a job that writes does not start, and git's reason is shown; a read-only job runs in the folder as usual. ASIST's git does not read the `safe.directory` setting, so this applies to repositories that git takes for someone else's, such as one cloned by another account or one on a FAT or exFAT drive on Windows.

Edits to an existing folder that is not under Git are written straight into that folder. A job without a working directory creates a working folder of its own and runs there. Memory curation merges its changes on its own only when every change is to a file inside the memory folder.

## Following the progress and the results

Under "Agent" in the Dock, you see the list of jobs, the log of the selected job, and below it a card for each output file. Click an output file to see its contents on a file card. You can select and copy text in the log, and "Copy" puts the whole log on the clipboard.

In the conversation, you follow jobs on two cards. Ask "How are my jobs doing?" to get the list card. It shows the jobs that need a decision first (waiting to be merged, or in conflict), then running jobs, then recently finished ones. A job card shows a single box that fits the job's stage: the diff and "Merge / Discard" when the job is waiting to be merged, the current step and the log while it runs, the summary and the output files when it is done, and the reason and the end of the log when it fails. When a job needs a decision or finishes, its card appears without you asking.

A canceled job shows "Stopping" until ASIST confirms that the agent and every command it was running have ended. If ASIST can't confirm that, the log says so, and "Try stopping again" stops the job again. When ASIST quits unexpectedly, running jobs are still told to stop. When it starts again, it confirms that each job has stopped before it finalizes the output files, and keeps the worktree if it can't confirm that. The history keeps the 50 most recent finished jobs.

Choose the engine and the default mode under [Agent](/en/docs/settings/agent/) in the settings.
