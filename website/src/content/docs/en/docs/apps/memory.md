---
title: Memory
description: The memory and the diary that the daily curation writes.
sidebar:
  order: 4
---

![The Memory mini app, open to a diary entry that ASIST wrote](/screens/en/memory.webp)

## Daily curation

The memory is written by the curation agent, which runs every day at midnight and works from the conversation logs up to the previous day. If the app isn't running at midnight, the curation runs the next time the app starts. It runs in the background, even during a conversation, and appears neither on the screen nor in the list of jobs. What you asked ASIST to remember ("Remember this") is added during the curation, and anything you told it to forget ("Forget what I just said") is not written. The curation agent writes a first-person diary of what it did that day, what it was asked and what it thought, and adds its own impressions to the pages about people and places.

The curation uses the codex or claude CLI ([Setting up the Agent](/en/docs/start/agent-cli/)). Under "Memory" in the settings, you can check the state of the curation and run it right away. If the curation fails, the reason appears there, and it tries again at midnight the next day. The conversations from the day that failed are kept for the next curation.

## What goes into a conversation

Only "Always keep in mind" (`instruction.md`) goes into every conversation. It sums up who you are, what ASIST itself is like, and what you have asked of it. The curation agent writes it, and you can also edit it on the Memory screen. Text you edit by hand stays through later curations. "About me", "The user", the pages and the diary are searched, and only what relates to what you are talking about is added to the conversation. The search combines matching words with closeness in meaning (multilingual-e5).

## Reading and editing

Under "Memory" in the Dock, you can read and rewrite every document. The list on the left is split into "Me and the user", "Diary" and "Pages", and you can filter it by name, alias and heading. Each document is a Markdown file, and Git keeps the history of the folder they are in. Saving makes a Git commit. Content that breaks the rules (such as the length of headings and text, a heading used twice in one file, or the "Summary" heading at the top of a page) is not saved, and the reason is shown. If the curation changed the same document while you had it open, your edit does not overwrite it, and the screen tells you so. Cancel editing to see the current version. If the curation deleted the document, it is not written again; the screen tells you so and keeps what you wrote in the editor. A page you delete may be written again by the next curation if it comes up in conversations from days that are not curated yet.
