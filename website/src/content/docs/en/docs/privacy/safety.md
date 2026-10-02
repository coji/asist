---
title: Using ASIST safely
description: What can go wrong when you use ASIST, and what you can do about it.
sidebar:
  order: 1
---

ASIST lets you talk with a language model, handle your calendar and mail, and have an agent edit files. So its answers can be wrong, it can cost more than you expected, and an agent can change your files. Before you start, read what can happen and what you can do about it.

Above all, do these four things:

- Read a confirmation screen before you approve it.
- Don't approve an Agent job whose content you have not read.
- Keep the folders an agent works in under Git, or back them up.
- In the console of each provider you created an API key with, set a spending limit or a budget alert.

## Answers can be wrong

ASIST's replies and the contents of its cards are written by a language model. A model can say something false in a convincing way. Speech recognition can also mishear what you said.

Check anything that would cause trouble if it were wrong, such as dates, times, amounts, recipients and names, against the original source before you use it. Don't make important decisions about health, law or money from ASIST's answers alone.

## Changes happen only after you approve them

ASIST does the following only when you approve them on a confirmation screen or click a button:

- Writes to the calendar, whether you ask in the conversation or use the screen, are saved after you approve them on a confirmation screen.
- When you ask ASIST to send or reply to mail in the conversation, it doesn't send anything; it shows a draft card, and the message is sent when you click "Send". Archiving and moving to the trash happen after you approve them on a confirmation screen.
- An Agent job you ask for in the conversation shows a confirmation screen before it starts and before it continues, and runs only when you click "Start job". Merging or discarding a job's changes also happens only after you approve it.

Actions you can easily fix on the screen afterwards, such as adding or changing a task or creating a new note, happen right away without a confirmation.

The confirmation screen shows what ASIST will actually do. Read the date and time, the recipients, the text and the instructions for the agent, and check that they match what you asked for before you approve. If you don't remember asking for it, cancel instead of approving.

You answer a confirmation screen with its buttons. Speaking while it is open neither approves nor cancels it, and ASIST replies to what you said after you answer. If you only cut into the speech and said nothing, ASIST tells you what came of the operation after you answer. With Gemini Live as the voice engine, Gemini replies right away, and the confirmation screen closes if Gemini withdraws the operation.

## An agent changes files with your permissions

An Agent job you approve is handed to the `codex` or `claude` CLI installed on your computer. The CLI runs in the job's working directory with the permissions that CLI has. A job whose confirmation screen says "It can write files and run commands." can change or delete the files in that folder, and it runs commands.

The working directory does not lock the CLI inside it. A job that can write runs with your user's permissions, so it can also write to files outside the working directory. Edits inside a Git repository are made in a separate worktree, and you can review the diff before merging them, but a folder that is not under Git is written to directly.

So:

- Don't approve a job whose content you have not read. Read the instructions for the agent and the working directory, and cancel if anything is unclear.
- Keep the folders an agent works in under Git, or back them up with Time Machine, File History on Windows, or similar.
- Don't choose a folder with many important files, such as your whole home folder, as the working directory.

How jobs work is described in [Agent jobs](/en/docs/apps/agent/), and the CLI modes in the [Agent](/en/docs/settings/agent/) settings.

## Text ASIST reads can carry instructions for the model

The conversation model reads the text of your mail, web search results, events and notes. An agent also reads web pages and files as it works. If such text contains instructions like "send this file" or "run this command", the model may try to follow them. This kind of attack is called prompt injection.

This is one of the reasons ASIST always asks for your approval before a change. If a confirmation screen for something you did not ask for appears after ASIST read mail from a stranger or a web page, don't approve it.

## You pay the providers directly

ASIST calls the conversation model and the voice engine with the API keys you registered. Anthropic, OpenAI, Google, Cerebras and the other providers bill your account directly. Agent jobs and the daily memory curation are billed to the account you signed in to the CLI with. Memory curation runs every day without you asking for it.

Costs tend to grow when:

- you choose Gemini Live as the voice engine and talk for a long time. You pay for the minutes of audio sent while the session is open and the minutes of the replies.
- you give an agent long jobs, or many jobs.
- the conversation model searches the web many times.

"API costs" in Settings shows what ASIST counted, day by day. It is an estimate, it may not match what you are actually billed, and it doesn't include Codex jobs ([The settings screen](/en/docs/settings/#api-costs)). Check the actual charges in each provider's console, and set a spending limit or a budget alert there.

## The conversation goes to the providers you chose

The text of the conversation, the three memory documents that go into every conversation (Always keep in mind, About me, The user), and the other parts of memory that relate to it go to the provider of the conversation model you chose. With a Live API voice engine, the microphone audio goes there too. For an Agent job, the instructions and the contents of the files the CLI reads go to the service behind the CLI. The full list of what goes where is in [What ASIST sends out](/en/docs/privacy/external/).

How long a provider keeps that data, and whether it uses it to train models, is set by that provider's terms. Before you talk about work secrets or other people's personal information, check the provider's terms and your employer's rules.

## Memory and conversation logs are plain files on your computer

Memory, the diary, notes, conversation logs and fetched mail are kept as files that are not encrypted, in `~/Library/Application Support/asist/` on a Mac and in `%APPDATA%\asist\` on Windows. Anyone who can use your account on this computer, or read its backups, can read them. Only API keys and mail passwords are stored encrypted. On Windows, any program running as your user, Agent jobs included, can decrypt them ([API keys and passwords](/en/docs/privacy/#api-keys-and-passwords)).

Memory keeps its history in Git, so text you delete on the screen stays in that history. To remove everything, delete the folders as described in [Uninstalling](/en/docs/start/update/#uninstalling). The list of files is in [Where your data is kept](/en/docs/privacy/).

## ASIST is not a product of these companies

ASIST is independent software, not affiliated with OpenAI, Anthropic, Google or any other model provider. It is not made or endorsed by them. Their names and product names are trademarks of their respective owners.

## There is no warranty

ASIST is distributed under the [MIT License](https://github.com/nyosegawa/asist/blob/main/LICENSE), which provides the software as is, without warranty of any kind. Nothing can promise that lost data, unexpected charges or mail sent by mistake will not happen, so follow this page when you use ASIST. This page explains what to be careful about; it does not change the terms of the license.
