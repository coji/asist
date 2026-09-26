---
name: theme
description: How to add, change or remove an ASIST theme (the colours, surfaces, radii, glows, background picture and card heading type the whole UI is drawn with), and how to give a new screen, card or control colours that follow the theme. Use when asked to add, create, delete, rename or retune a theme (テーマを追加して、テーマを作りたい、テーマを消して、配色を変えて、着せ替え、ダークモード、ライトテーマ、背景画像を変えて), when editing src/renderer/src/assets/themes.css, a theme.css or a --ui-* / --card-hue / --color-holo-* token, when writing CSS that needs a colour, or when a screen looks wrong in one theme only. Do not use for the layout of one card (panel-card-design), for text (ui-text), or for checking a screen that looks wrong in every theme (visual-debugging).
---

# Themes

A theme is a set of values for CSS variables. Every component reads its colours, surfaces, radii, glows and the app background from role tokens, so a theme changes the whole UI without touching a component. docs/adr/0009 records why a theme may resize only the card headings; read it before changing that boundary.

## Where a theme lives

| What | Where |
| --- | --- |
| The list of themes and the default (`future`) | `src/shared/themes.ts` (`THEMES`, `DEFAULT_THEME`) |
| future's values, the rules every theme shares, the picture of every theme (`--app-picture-<name>`) and one `@import` per theme. Its header lists what a theme decides and what each palette colour means | `src/renderer/src/assets/themes.css` |
| One theme: a `:root[data-theme='<name>']` block and a card frame block, beside its picture | `src/renderer/src/assets/themes/<name>/theme.css`, `…/<name>/background.webp` |
| The prompts the pictures were made from | `src/renderer/src/assets/themes/prompts.json` (future's: `resources/artwork/prompts.json`) |
| The Tailwind palette future is built on (`--color-holo-*`, `--shadow-glass`) | the `@theme` block of `src/renderer/src/assets/main.css`; every theme overrides it |
| The name and one-line description on the settings page | the dictionary, `settingsAppearance.themes.<name>` |
| The saved choice | `theme` in `src/shared/settings.ts`, a stored format with versions (docs/adr/0008) |

## Add a theme

1. Add the name to `THEMES`. The settings page, the demo's picker, `?theme=`, `demo:gallery --theme` and `demo:fit` follow the list.
2. Make the picture with the image tool you have (the `imagegen` skill, for example). Write the prompt in English in the form of the others in `prompts.json`: 16:9 at 2048x1152, no text or UI, and no single focal point, because cards cover the left and right and the orb and the conversation sit in the middle. Save it as `themes/<name>/background.webp` (Pillow: `Image.open(src).save(dst, 'WEBP', quality=82)`; 1672x941 is fine), add the prompt to `themes/prompts.json` under the theme's name, and add `--app-picture-<name>` next to the others in future's block of themes.css.
3. Copy the `theme.css` of the closest theme (a light one: `simple` or `pop`; a dark one: `cool`) into `themes/<name>/`, rename the selectors and the opening comment, and add `@import './themes/<name>/theme.css';` beside the others at the top of themes.css. Keep the order of the copied blocks; the header of themes.css lists what to decide.
4. Change the values. Every token must get a value: the test fails on one left out, because a value of future left in a light theme is a dark patch nobody notices. The palette names are roles, not hues: put the theme's main accent in `--color-holo-cyan` even when it is pink. Cards keep their own hue on purpose, so a card stays recognisable; the card frame block decides how strongly the hue shows (the chroma factors in its `oklch(from var(--card-hue) …)`), and may pull every card towards the theme's colour with `color-mix`.
5. The card headings (`--card-kicker-*`, `--card-title-*`, `--card-number-*`, `--card-hero-align`) may keep future's values.
6. Add the name and description in eleven languages with `npm run i18n` (the `ui-text` skill): `settingsAppearance.themes.<name>.name` and `.description`.
7. In README's 「見た目」 section, add the theme with its description to the list and update the number of themes there.
8. Verify, below.

## Change a theme

Change values in its `theme.css` only; a component never names a theme. A heading value changes heights, so run the fit check afterwards. A change in future's values shows in every screen of the product as it is today: compare captures before and after.

## Remove a theme

Removing a name from `THEMES` makes a saved `settings.json` that chose it unreadable, since `theme` is an enum. So raise `SETTINGS_FORMAT.version`, add an upgrade that moves that name to `future`, and add a sample of the new version to `tests/fixtures/stored/` (AGENTS.md, docs/adr/0008). Then delete its folder under `assets/themes/`, its `@import` and `--app-picture-<name>` in themes.css, its entry in `prompts.json`, its dictionary entries (`npm run i18n -- remove settingsAppearance.themes.<name>`) and its line in README.

## Colours in new UI

- Pick the token by role: text (`--ui-text`, `-strong`, `-soft`, `-muted`, `-faint`), lines (`--ui-line`, `--ui-divider`, `--ui-line-active`), surfaces (`--ui-glass` for bars and dialogs, `--ui-panel` for a mini app, `--ui-sheet` for a pane opened over a list, `--ui-box` for a box, `--ui-raised` for an item standing on a box, `--ui-field`, `--ui-control`), the palette by its role (the header of themes.css) with `--ui-tone-*-text` for text in a tone, `--ui-focus-ring`, `--ui-scrim`. A translucent tone is `rgb(from var(--color-holo-cyan) r g b / 0.12)`. A glow is scaled by `--ui-glow-strength`.
- A card sets only `--card-hue` in its frame class; inside it use `--card-accent`, and fade a backdrop into `--card-background`.
- Add a token only when no role fits. Give it future's value in themes.css and a value in every theme.css, in the same change, and name it by role (`--ui-…`) unless it exists in one area only (`--cal-…`, `--code-…`, `--hud-…`).
- A colour drawn on a canvas does not follow CSS: read the token with `getComputedStyle` when drawing and redraw when `data-theme` on `<html>` changes (`AudioViewer.tsx`).

## Rules and their reasons

- A theme changes no size or spacing except the card headings. The s / m / l switching of cards depends on measured heights, and the fit check can only keep up with the headings.
- Draw a thicker outline with `box-shadow`, never a wider `border`: a border grows every card and pushed one past its s height. A filled kicker keeps the header at 17px (the line height in `.panel-kicker`).
- The pictures behind the weather and clock cards stay night scenes in every theme. Text over them carries `.ui-on-scene`, which gives it future's text colours.
- `--ui-kicker` is text on the surface; the filled kicker of a card uses `--card-kicker-ink` and `--card-kicker-fill`, so a light kicker on an ink pill does not leak into other text.
- On Windows the minimize, maximize and close buttons sit over the top right of the page with no background of their own, and their symbols are drawn in `--ui-text`, which `applyTheme` sends to the main process. A theme's `--ui-text` therefore has to read over the top right of its picture, where no surface lies under the buttons.
- Tests name no theme and list none; they read `THEMES`, so adding a theme does not break them.

## Verify

1. `npm run typecheck`, `npm test` and `npm run i18n -- check`. `tests/themes.test.ts` fails on: a theme without its `theme.css` or its `@import`; a picture variable missing or pointing at no file; a prompt missing from `prompts.json`; a name or description missing from the dictionary; a rule nested inside another (a lost `}` hides everything after it); a token declared twice in one theme; a theme token without a future value; a token left out of a theme; a token the UI reads that nothing declares. Nothing checks that a colour looks right: that is step 3.
2. `npm run demo:fit` with no arguments before you finish. `--theme <name>` narrows it while you iterate, but a new theme also adds a tile to the settings page in every other theme.
3. Look at it (the `visual-debugging` skill), and look at every image; the numbers do not show a colour that is wrong.
   - `npm run demo` and the theme picker at the top of the shell.
   - Cards: `npm run demo:gallery -- <dir> --theme <name> --type weather --type fx --type calendar` and so on, a few types at a time; the full gallery is too tall to capture cleanly.
   - Conversation with cards: `npm run demo:drive -- --launch --url "/app?theme=<name>" --size l --say "長野県の今日の天気を教えて" --say "ドル円のレートを教えて" --out <dir> --shot conversation` (a `say=` in the URL is captured before the replies finish).
   - Screens: `npm run demo:drive -- --launch --url "/preview/screens/calendar?theme=<name>" --size l --out <dir> --shot calendar`, and with `--goto` in the same run: `tasks`, `mail/message`, `notes/note`, `settings/appearance`, `setup`.
