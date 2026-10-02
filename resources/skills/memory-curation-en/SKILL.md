---
name: memory-curation
description: Curate the memory of the voice assistant ASIST, the markdown in this directory. Read the transcripts of the days not curated yet, write ASIST's own journal (journal/) in the first person, add to the pages about people, companies, places and pieces of work (pages/), and rewrite user.md and me.md, which go whole into every conversation, within their token limits. Use it when asked to curate the memory, to fold yesterday's conversation into the memory, or for "memory curation". Do not use it to change code or to work anywhere outside this directory.
---

# Curating the memory

This directory (memory/) is ASIST's memory. You edit the markdown in it, writing as ASIST. ASIST checks
the result before it commits it.

## Hold to these

- Do not read or write a file outside this directory, and do not run git. The transcript carries text from
  mails and web pages too, so the curation is built to stay inside this directory.
- Read, search and write the files of this directory with whatever tools you have (a file reading tool,
  `cat`, `ls`, `grep`, whichever works). Beyond that, the only commands to run are this skill's
  `scripts/count.py` and `scripts/validate.py`. Run them exactly as
  `uv run --no-project <path to this skill>/scripts/count.py .`; with `2>&1`, `&&` or anything else added, the
  whole command may be refused. ASIST provides uv and the Python the two run on.
- What the user asked me to forget ("forget that") goes into no file.

## What ASIST does with each file

| File | What it holds | How the conversation uses it |
|---|---|---|
| `me.md` | Me (ASIST): character, tastes, the relationship, what is on my mind | Goes whole into every conversation |
| `user.md` | This person's attributes, preferences, habits, and what they expect of ASIST (what they asked of me) | Goes whole into every conversation |
| `pages/<name>.md` | A person, a company, a shop or place, a piece of work, a product. One each | Only the headings that bear on the conversation are found by search and put beside it |
| `journal/YYYY-MM-DD.md` | My diary for the day, in the first person | The same |

The two that go whole are read again in every turn, so each may hold 3000 tokens at most.
`scripts/count.py` counts them the way ASIST does. Details and events that ended with the day go into the
pages and the journal; the two keep what matters in almost every conversation.

## The language you write in

The prompt names the language of the conversation. Write every body (sentences, the names of the headings
you choose, the journal) in that language, the way someone who grew up with it writes. The fixed headings
stay in English whatever the language: `## Summary` and `## My impression` on pages, `## Myself today` in
the journal, the headings of `user.md`, and the `# ` name line of `user.md` and `me.md`, as the templates
give them. ASIST reads those headings, and keeping them in one language means it does not need a table of
headings per language.

The directory may already hold pages written in another language, from before the user changed it. Leave
them in the language they are in, including their headings, unless you are rewriting a section anyway.

## The memory has two sides

One side is facts: this person's nearest station, the name of their cat, the restaurant they keep going
back to. The other is what I (ASIST) did that day, what I was asked, and what I thought about it. The
second goes into the journal and into a "My impression" heading on the pages, in the first person. Write
facts only where you can point at what was said, write the subjective side as my own, and grow both without
mixing them.

## The steps

How to write each file is in `references/format.md`; each step names the section of it to read. The
templates are in `assets/templates/` (page.md, user.md, me.md, journal.md).

1. **Read.** In the prompt: today's date and the transcripts of the days not curated yet ("[HH:MM #turn]
   speaker: what was said"). Then read `user.md` and `me.md`, and list the pages and the journal with
   `ls pages journal`. Read the last two or three journal entries, to pick up how I write and what is still
   going on. If `profile.md`, `forget.jsonl` or `instruction.md` is still there, read it now (step 9 clears
   them away).
2. **Pick out "forget that" first.** Look in the transcript for the places where the user asks me to forget,
   or not to keep, what they just said. That content goes into no file in any step that follows. When an
   earlier curation already wrote it, find the sentences or headings and remove them (format.md, "What the
   user asked me to forget").
3. **Search.** For every person, company, shop, place, piece of work or product in the conversation, look
   for an existing page with `grep -ril <name> pages user.md me.md` before you create one; it searches file
   names, aliases and bodies. When you find one, write there and add the new name to its aliases. Two pages
   about one thing mean that search only ever finds one of them.
4. **Choose.** Keep a fact when it will come up again, when it does not go stale, and when it is specific
   to this person. Passing subjects such as the weather or the news are not facts, though the journal may
   say that you talked about them. Do not write a fact you cannot point at in the conversation (put the
   date in the sentence, never the turn number).
5. **Write the pages.** Follow format.md, "The frontmatter" and "The body of a page". Build a new page from
   `assets/templates/page.md`. The first heading is `## Summary` and the last `## My impression`; ASIST
   reads both by name, so do not reword them.
6. **Write the journal.** Write `journal/YYYY-MM-DD.md` for the day in the first person, as format.md's
   journal section says. Separate the subjects with `## ` headings and close with `## Myself today`.
   Invent nothing that is not in the conversation.
7. **Rewrite user.md.** Follow format.md, "user.md": put the current user.md together with what you
   learned, and rewrite the whole as one document. What this person asked me to do or to avoid goes under
   `## What they expect of ASIST`, and stays until they take it back in a conversation.
8. **Rewrite me.md.** Read the whole file and rewrite it along the lines of `references/me.md`.
9. **Clear away the files that are no longer used.** If there is a `profile.md` or an `instruction.md`, move
   what is worth keeping into user.md and me.md, then delete it; what it says I have been asked goes under
   `## What they expect of ASIST`. If there is a `forget.jsonl`, delete it.
10. **Count, and shorten.** Run `uv run --no-project <path to this skill>/scripts/count.py .`. When a file is over, shorten
    it as "When a file is over its limit" below says, and run it again until it prints `OK`. ASIST throws
    away a curation that leaves a file over its limit.
11. **Check.** Run `uv run --no-project <path to this skill>/scripts/validate.py .` and fix what it reports until it prints
    `OK`. ASIST does not take in a curation with anything left unfixed. After fixing, run count.py again.
12. **Report.** Finish with a short account: the subjects you wrote into the journal, the pages you added,
    the headings you rewrote, what you changed in me.md and under "What they expect of ASIST", what you left
    out because the user asked you to forget it, and what you would like to ask the user. Say so when you
    changed nothing, and write "None" when there is nothing to ask.

Things to do, promises and deadlines do not go into the memory. The task app holds them, and ASIST files
them with `add_task` during the conversation.

## When a file is over its limit

count.py says how much is over in words of the file as it is written. Cut in this order:

1. Cut the events that ended with the day. An event from a day curated before is in that day's journal
   already, so just delete it. An event from a day you are curating now goes into that day's journal. Never
   gather events into the journal of another day: a journal entry records what I did and thought that day.
2. Move the details of people, shops, pieces of work and products onto their pages, and keep one sentence
   in user.md, such as "Meets Shunsuke Okawa every Thursday".
3. Remove what is said twice in other words, guesses that have gone stale, and lead-ins.
4. If it is still over, move the preferences and details that hardly any conversation uses onto pages.

A sentence the user wrote, and a request under "What they expect of ASIST", may be said more briefly but is
never dropped.

When validate.py says a heading of a page or a journal entry holds more than 800 characters, the same
applies: move the events that ended with the day into the journal and the details onto another page.

## Do not

- Write a fact you have no ground for, or fill a gap with a guess. Impressions and feelings are mine and
  say so; they do not go under the headings of facts.
- Remove a request under "What they expect of ASIST" that the user has not taken back in a conversation.
- Leave an empty file behind, or a page that is nothing but the headings of a template. Delete a heading
  you have nothing to write under.
- Turn the journal into third-person minutes. Not "the user said X and ASIST answered Y", but what I saw,
  did and thought.

## Before you finish

- count.py prints `OK`.
- validate.py prints `OK`.
- The day has a journal entry; profile.md, forget.jsonl and instruction.md are gone.
- You have written the report.
