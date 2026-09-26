---
name: adr
description: Write, rewrite or consult ASIST's decision records in docs/adr (one short Japanese file per decision). Use when a choice between options is settled in the conversation (「AとBどっちにする?」→「Bで」「それでいこう」「そうしよう」), when the user rejects an approach for a lasting reason (「それはやめよう」「やらない」), when a change would contradict or reverse a record in docs/adr, or when asked to record a decision (ADRにして、記録しておいて、決めたことを残して). Do not use for a reason that concerns one place in the code (that is a comment), for a rule a test or script can enforce, or for a procedure (that is a skill).
---

# Decision records

A decision record keeps what the code cannot show: why ASIST does something one way and not another, and what was tried or rejected. Future agents list `docs/adr` and read a record only when its file name covers the behavior they are about to change, so a record has to be short, findable by its name, and true today. There is no index to keep: the file names are the index.

## 1. Decide whether it is a record

Write one only when all three hold:

- **Hard to reverse.** Undoing it would touch several processes or features, stored data, or what the user has learned to expect.
- **Surprising without the reason.** A capable agent reading the code would be tempted to "fix" it.
- **A real choice.** Other options existed and were weighed.

A decision not to do something counts, and so does a proposal the user turned down, because the code can never show either.

Put it elsewhere when it fails the test:

| What it is | Where it goes |
|---|---|
| The reason for one piece of code, a measured value, an API quirk | A comment next to that code (AGENTS.md, Comments) |
| A rule a test or a script can check | That test or script |
| A procedure for a kind of task | A skill |
| A rule every task must follow | AGENTS.md |

When a decision is settled in the conversation and passes the test, say so and write it in the same change: 「これは ADR の条件に当てはまるので、docs/adr に書きます」. Do not wait to be asked.

## 2. Write it

- File: `docs/adr/NNNN-<slug>.md`, where NNNN is the highest existing number plus one. The slug is an English phrase naming the behavior as a task would describe it (`language-settings-are-three`, `notes-are-never-changed-by-the-agent`), since agents choose what to read from the names alone. Not a topic (`i18n`, `notes`).
- The heading is the decision itself in Japanese (「言語の設定を、画面の言語、会話の言語、地域の3つに分ける」), not a topic (「多言語対応について」).
- The body is Japanese, one paragraph by default: what was decided, and why. Add these sections only when they have content:
  - `## 見送った案`: each option not taken, with the reason in a sentence. Only options that were compared as designs belong here, not one the user merely confirmed in a conversation, and never the history of the discussion.
  - `## 実測`: the value, the condition it was measured under, and the date.
  - `## 分かっている制約`: limits that follow from the decision.
- Write only what the code cannot show. No file lists, no implementation steps, no restating of types or function bodies. A name that anchors the decision (such as the one function that decides it) may appear.
- Do not invent a reason. If the reason is not known, ask the user or leave the option out.
- Write plain, complete Japanese sentences with everyday words; no coined nouns, no word-for-word translation of English phrases.
- Commit it with the code change it belongs to.

## 3. When a decision changes

Keep one true record, not a history:

- Rewrite the record so it states the new decision, and move the old approach into `## 見送った案` with the reason it was dropped. Rename the file (keeping its number) if the slug no longer names the behavior.
- If the decision no longer applies at all, delete the record. Git keeps the history.
- Never leave a record that says something the code no longer does.

## 4. Reading records

- List `docs/adr` and read a record only when its file name covers the behavior you are about to change. Do not read the records one after another to look for something.
- If your change contradicts a record, stop and tell the user which record and why you think it should be reopened. Change the record only after the user agrees, in the same commit as the code.
- Code never refers to a record. If code needs the reason next to it, write the reason in a comment.
