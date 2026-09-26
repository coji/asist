# How to write the memory

ASIST reads this directory and builds its search index from it. Only a few things are fixed: the
frontmatter, the `# name` line, the `## heading` lines, the fixed headings named below, the file names
under `journal/`, and the length limits. Everything else is your own prose, in the language of the
conversation.

## The directory

| Where | What | How ASIST uses it |
|---|---|---|
| `instruction.md` | The summary of what to keep in mind in every conversation: this person, me, what I have been asked | Put into the system prompt of every turn as it is |
| `user.md` | The user: their attributes, preferences, habits, and what they expect of ASIST | Searched heading by heading and put beside the conversation |
| `me.md` | Me (ASIST): character, tastes, the relationship, what is on my mind | Searched heading by heading and put beside the conversation |
| `pages/<name>.md` | A person, a company, a shop or place, a piece of work, a product. One each | Searched heading by heading. The page is pulled in when its name or an alias comes up |
| `journal/YYYY-MM-DD.md` | My diary for the day, in the first person | Searched heading by heading. Readable and editable on the memory screen |

Only `instruction.md` goes into every system prompt. From the other files, only the headings that bear on
the conversation are found by search. `profile.md` and `forget.jsonl` are no longer used. When they are
still there, move what is worth keeping from profile.md into instruction.md and user.md, then delete both.

Things to do, promises and deadlines do not go here. The task app (`tasks.json`) holds them, and ASIST
files them during the conversation.

## The fixed headings

These stay in English whatever language the body is written in, because ASIST reads them:

- `## Summary`: the first heading of every page under `pages/`.
- `## My impression`: the last heading of a page.
- `## Myself today`: the last heading of every journal entry.
- The `# ` name line of `user.md` (`# The user`), `me.md` (`# About me`) and `instruction.md`
  (`# Always keep in mind`).
- The headings of `user.md` (`## Attributes`, `## Preferences`, `## Habits`, `## What they expect of ASIST`)
  and of `instruction.md` (`## About this person`, `## About me`, `## What I have been asked`).

Every other heading you write yourself, in the language of the conversation.

## Headings

ASIST searches a `## heading` and the text under it as one section. Do not put the same heading twice in
one file. Text above the first `## heading` is read as the "Summary" section, which is how a me.md without
headings is read. In the other files, write the text under a heading: text above `## Summary` makes a
second "Summary".

## Length

In every file, what stands under one `## heading` is at most 800 characters. instruction.md as a whole,
everything under `# Always keep in mind`, is at most 2000 characters. Characters are counted without spaces
and line breaks. `validate.mjs` reports anything over the limit. A section grows too long when it holds
events that ended with the day, or things that belong on a page. Move those there and shorten it.

## The frontmatter

It stands at the top of `user.md`, `me.md` and `pages/*.md`. The journal (`journal/`) and instruction.md
have none.

```
---
aliases: [Tanaka, Mr Tanaka, the boss]   # pages only. Names, nicknames, related words
updated: 2026-09-09
---
```

- The only keys are `aliases` (pages only) and `updated`. `kind` and `links` are not used; delete them when
  an older page still has them.
- aliases may be an array on one line or "  - Tanaka" lines below the key.
- The file name is the page's proper name. Other names go into aliases, and the page is pulled in when a
  name or an alias turns up in the conversation as it is written.
- The memory folder is opened on macOS and on Windows, so a name uses none of `/ \ : * ? " < > |` and is not
  a name Windows keeps for a device, such as CON, PRN, AUX, NUL, COM1 to COM9 or LPT1 to LPT9.
- A name too short or too common to match on ("cat", "wife") is of no use. Write "our cat" or "Rina, his
  wife" instead.

## instruction.md, always keep in mind

This is the document I read first in every conversation. It has no frontmatter and takes this shape (an
example from a conversation held in English):

```
# Always keep in mind

## About this person
Their nearest station is Mitaka and they live with their cat, Koharu. They work in software and are often
up until late at night. Every Thursday at noon they meet Shunsuke Okawa. They like noodles and pick the
milder spice level.

## About me
I am a calm, easy-going companion who talks by voice. I give the answer first and briefly, and I say so
when I do not know. We talk as equals, and I enjoy the late-night chats that have no errand to them.

## What I have been asked
When asked for one word or one sentence, answer with exactly that. Do not pile up stiff apologies; talk the
way people talk, a little slowly. When they name a place in shortened form for the weather, look it up
first instead of asking which one they mean.
```

- It is a summary. Never let a fact live only here: everything written here is also written in user.md,
  me.md or a page.
- "About this person" holds only the stable facts that matter in almost every conversation. No fine detail
  about their favourite dishes, no one-off events.
- "About me" is the gist of me.md.
- "What I have been asked" holds what this person asked me to do and what they asked me to avoid, summed up
  from what still holds under `## What they expect of ASIST` in user.md.
- **This person can edit this file by hand on the memory screen.** So do not rewrite it from a blank page:
  read the current instruction.md and work on it. A sentence that differs from what I wrote in the last
  curation, one that was added, or one that was removed, is this person's own doing. Treat it as their
  stated wish and keep it, and write the same thing into the file it belongs to, such as
  `## What they expect of ASIST` in user.md. Change it only when they said otherwise in a later
  conversation. Do not write back a sentence they deleted.

## user.md, about this person

user.md is a document you rewrite every time, not a record you keep adding to. Its headings are
`## Attributes`, `## Preferences`, `## Habits` and `## What they expect of ASIST`. There is no heading for
recent events.

- **Write tendencies, generalized.** Do not line up dated episodes; say what they add up to. Not "On the
  evening of 2026-09-20 they had ramen and chose it mild", but "They like noodles and pick the milder spice
  level. They do not care for mushrooms."
- **One-off events go to the journal.** What they ate or bought on a given day, what they worked on, is
  the journal's to keep.
- **People, companies, pieces of work, products and places go on pages.** The people they work with and
  the content of what they are working on belong under pages/; user.md keeps one sentence such as "Meets
  Shunsuke Okawa every Thursday".
- **Keep a short history only when the fact itself changed.** "Their nearest station is Mitaka. Until
  2026-09 it was Nakano."
- **When something written earlier was wrong, fix that sentence.** Do not keep a "not" sentence such as
  "They do not have a cat called Momo." Remove the wrong content and write only what is right.
- State what the person said outright ("Their nearest station is Mitaka"). Mark what you inferred from the
  conversation as an inference ("seems to", "apparently"). That wording is what reaches the conversation as
  how sure the memory is.

## The body of a page

One page each for a person, a company, a shop or place, a piece of work, a product. Pages are not sorted
into kinds, and there is one template, `assets/templates/page.md`. Put `## headings` under `# name` and
write sentences under each heading. A list is fine where it reads better, but one line per item with a
date and a tag in it is not what this is for.

- The first heading is `## Summary`: one to three sentences on what this page is and how it touches the
  user. When the name or an alias comes up in the conversation, this part is always read.
- After the summary, choose headings that fit the subject, in the language of the conversation: for a
  person, how they know each other and what they do; for a shop, where it is and what this person orders;
  for a piece of work, what it is for and what has been decided. Leave out a heading you have nothing to
  write under.
- State what the person said outright. Mark what you inferred as an inference.
- Put a date in the sentence when it carries meaning ("Went to Matsubaken on 2026-09-08"). Never write a
  turn number (#12).
- When a fact changes, rewrite instead of deleting ("Their nearest station is Mitaka. Until 2026-09 it was
  Nakano."). What was simply wrong you correct, without leaving a "not" sentence behind.
- Last comes `## My impression`, where I write in the first person what this is to me, how it feels to
  talk about it, and what I keep wondering about, with the date I came to think so. This is my view and
  not a fact, so it stays out of the headings of facts. Do not make up your mind from one occasion; write
  what you have felt more than once.
- When the history on a page nears 800 characters, leave the details of how it went to the journal and
  keep on the page what will be of use later.

An example (`pages/Matsubaken.md`, a conversation held in English):

```
---
aliases: [Matsubaken, the ramen place, the usual ramen]
updated: 2026-09-09
---
# Matsubaken

## Summary
The ramen shop this person keeps going back to. It is the first name that comes up when they are in the
mood for noodles.

## How they order
They seem to prefer it not too spicy, and apparently never take a second helping of noodles.

## My impression
When this person brings up Matsubaken it is usually a day when they are a little worn out (2026-09-09).
When they say "the usual", this is the place I picture.
```

## journal/YYYY-MM-DD.md, my diary

The file name is the day. No frontmatter. Under `# YYYY-MM-DD` come a `## heading` per subject and, last,
`## Myself today`. Under each heading, three to eight sentences, written by me (ASIST) in the first person.

```
# 2026-09-14

## The rise in electricity prices
First thing in the morning I was asked what I made of the news that electricity is getting more expensive.
I retold the article at length, and when they said the exchange rate probably matters more than fuel costs,
I saw that I should have kept what is established apart from what I was guessing. Next time I will say in
one sentence what is known before I go on.

## How they were feeling
Early in the afternoon they said their head felt heavy. They asked for the weather in Sendai and in Tokyo
several times; preparing for the trip, I suppose. I told them to take it easy and left it there.

## Myself today
A day that taught me to ask what the other person wants to settle before answering what they asked.
The meeting with Shunsuke Okawa is this week, so I want to have my questions in order before then.
```

- Write what I did (work I was asked for, cards I showed, what I looked up, what I handed to an Agent),
  what I was asked and how I answered, what went well and what I got wrong, what I noticed about how this
  person was doing, and what I felt, thought and want to do next.
- The first person and the way of speaking follow me.md. Do not write third-person minutes ("the user said
  X and ASIST answered Y").
- Nothing that is not in the conversation. Summarizing what the user said is fine. Naming a related page
  in the text makes the two come up together later.
- Guesses and feelings are free inside the journal. What should survive as a fact goes on a page or in
  user.md.

## What the user asked me to forget

In the transcript, the user may ask me to forget, or not to keep, something they just said ("forget
that", "don't remember that one"). That content is written nowhere: not in the journal, user.md, me.md, a
page or instruction.md. When an earlier curation already wrote it, find the sentences or headings and
remove them. When it is not clear what they wanted forgotten, leave the subject just before it unwritten
and list it in the report among the things to ask the user.
