---
name: ui-text
description: How to add, change, move or translate any text ASIST shows or says - where a string goes (the dictionary in eleven languages, errorText, PromptText for the model, the spoken group), how to write it, how to edit the dictionary with npm run i18n, and how to check it fits in every language. Use when adding or rewording a label, button, message, error, toast, empty state or confirmation; when adding a screen or card that shows text; when fixing a translation; or when asked about 文言, 言い回し, 翻訳, 多言語, i18n, 辞書, メッセージ, エラー文, ボタン名. Do not use for prompt engineering of the conversation model beyond where its text lives, or for layout that is not caused by text (visual-debugging).
---

# Text on the screen and in the conversation

ASIST runs in eleven locales, and three settings decide which language a text is in (docs/adr/0001). Every string therefore has one place it belongs, decided by who reads it, and the dictionary holds the eleven languages side by side so that a change to one shows, in the same diff, which of the others it left behind.

## 1. Where a string goes

| Who reads it | Where it goes | Language it follows |
|---|---|---|
| The person looking at the screen | The dictionary, `src/shared/i18n/messages/<group>.ts` | Interface |
| The same, for an error | `errorText(key, values)` thrown as the error; the text is in the dictionary | Interface |
| The model | A `PromptText` `{ ja, en }` next to the code; `bilingual()` for a zod description | Conversation |
| The listener, or text sent in the user's name | The dictionary's `spoken` group, read with `tConversation` | Conversation |
| A name that is the same for every reader | A constant next to the code | None |

- **Dictionary.** Write all eleven languages in the same change. No word goes straight into a component, in any language.
- **Group.** Put a string in the group of the feature it belongs to, together with that feature's errors. `common` holds only words that mean the same on every screen (保存, キャンセル, 削除).
- **Errors** are thrown as keys, never as sentences. The screen turns the key into text through `displayError`, in the interface language; the log keeps English and the key.
- **Model text** stays out of the dictionary. The Japanese is hand-tuned and used as it is; the English is written as an English prompt, not translated. A marker put inside a message, such as `[記憶]`, comes from the table in `src/shared/conversation-markers.ts`.
- **The OS.** A text that names a part of the OS (Finder or File Explorer, System Settings or Windows Settings, the log folder, the system voice, the Trash or the Recycle Bin) is one message per OS, `<key>.macos` and `<key>.windows`, and the code picks it with `osMessageKey(key, os)` from `src/shared/i18n/os-message.ts`: the renderer passes `platformCapabilities().os` from `@/platform`, the main process the `os` of its own `platformCapabilities()`. Every other text, the model's included, names no OS: 「このコンピュータ」 and "this computer", not "this Mac". Only the text of a feature one OS alone has, such as the macOS calendar or Qwen3-TTS on the MLX runtime, may name that OS, because the capabilities keep it off the other.
- **Names that are never translated:** product and model names (VOICEVOX, Qwen3-TTS, Claude Code), the names a CLI gives its own modes (`AGENT_MODE_NAME`), identifiers and file names. Do not write a translated word right next to one.

## 2. Write it

Read `references/writing-guide.md` before writing text for the screen; it is the style guide for every language (buttons are verbs, a confirmation names the operation, no AI-style padding, and so on). Then:

- Write the Japanese first, then each other language as a speaker of it would write it, not word for word.
- Match the words the language already uses in that file for the same thing (`npm run i18n -- get <key>` shows a neighbour).
- A value filled into a message is a name, a number or another message, and the sentence reads without inflecting it. In German, a name that cannot take an article goes in quotation marks.
- Do not quote what the user should say. What the user says follows the conversation language, not the interface: write 「ASIST にメモを頼むと増えます」, not 「『メモして』と言うと増えます」.
- A sentence that names a button or a page quotes it exactly as that language shows it (tests/i18n.test.ts checks 「」 quotes).
- Rough widths: a status chip holds about 17 Japanese characters, a note beside a box heading about 36. Shorten the wording first; if one place overflows in several languages, fix the layout instead.

## 3. Edit the dictionary

Use the script rather than editing the nested objects by hand:

```bash
npm run i18n -- get notes.deleteNote
npm run i18n -- set notes.deleteNote '{"ja-JP":"メモを削除","en-US":"Delete note",…}'
npm run i18n -- set notes.card @/path/to/group.json
npm run i18n -- move memory.confirmDiscard common.confirmDiscard
npm run i18n -- remove tasks.notesCard
npm run i18n -- check
```

`set` refuses a message that leaves out a language. `move` also rewrites every use of the key that starts right after a quote in src, tests and scripts (a template such as `` `mail.x.${op}` `` included), and creates or removes group files and their entries in `src/shared/i18n/index.ts`. A key it cannot rewrite safely, such as one inside a longer string (`'[asist:mail.x'`) or a regular expression, is listed with its file and line and the command fails; change those by hand.

## 4. Rules in the code

- Read a language setting when it is used, never at module load; all three change while the app runs.
- Format dates and numbers with `useFormatLocale()` or `formatLocale()`, which combine the interface language with the region's habits. Passing `uiLocale` to `Intl` makes English always use a 12-hour clock.
- A test reads the text of the screen through the dictionary (`createTranslator('ja-JP')`, then `t('key')`), never as a copied Japanese string.

## 5. Check it

| What | How |
|---|---|
| Missing or unused keys, placeholder names, plural categories, quoted labels, words written straight into markup | `npm test` (tests/i18n.test.ts); an exception with a reason goes into that test's list |
| Every message has the eleven languages | `npm run i18n -- check` |
| The text fits on every card and screen, in every language | `npm run demo:fit` with no arguments (about 35 s) |
| Compare a message across languages | The demo's `/i18n` page (`npm run demo`), with `?q=` to filter and `?langs=` to pick languages |
| See a screen in one language | The language picker at the top of the demo |

Only Japanese and English have been read by native speakers. The other nine languages are written from the screen and the sentences around the text, and mistranslations are fixed as they are reported.
