---
name: visual-debugging
description: How to check how an ASIST screen looks and fix a broken layout, and the tools for it. Open the demo (the renderer alone) in headless Chrome to measure the height and position of elements, capture at 2x resolution, and do the same to the installed app over CDP. Covers the demo's shell (the list of samples), the card samples (/cards) and opening a screen directly (/screens). Use when asked to check how a screen, card, or view looks, take screenshots, debug layout (ずれ、はみ出し、見切れ、崩れ、余白、文字の大きさ、重なり), compare before/after, measure element sizes in the renderer, add demo fixtures or a new npm run demo:<scene> command, or mock a card or screen. Works the same from Claude Code and Codex. Do not use for unit tests, main-process behavior, or the installed build itself (install-mac-app, install-windows-app).
---

# Visual debugging

Judge by numbers and 2x images, so that the same commands produce the same artifacts whichever Agent does the work. A mock is not static HTML: it feeds fixed data into the app's own components. The tools are CDP scripts that run on nothing but Node 22 and the installed Chrome (found in its usual place on macOS and Windows, or named by `CHROME_BIN`), and they live in `scripts/cdp/`. Claude Code's browser pane is an optional tool for iterating faster; the images and numbers that go into the report come from the scripts.

## How the demo is put together

The demo is the renderer served by plain vite. Electron is not started. There is no `window.api`, so `src/renderer/src/demo/` stands in for the real main process.

The scripts serve the demo themselves. Each run of `demo:drive --launch`, `demo:open` or a scene starts the demo of the checkout it lives in, and a headless Chrome, on ports the OS picks, and closes both at the end. Nothing has to be started first, several runs can go at once, and a run in a worktree always measures that worktree's code. `npm run demo` serves the same demo on the fixed port 5174 for a person and for the browser pane; the scripts never use it.

| Location | Role |
| --- | --- |
| `demo/routes.ts` | The URL rules. The path says what is being looked at, and the query is only used to say how to look at it |
| `demo/index.tsx` | The entry point. It reads the path and decides whether to draw the shell, the card samples or the app |
| `demo/pages/Shell.tsx` | The shell. The list of samples on the left, and an iframe showing a sample on the right. Each selection rebuilds only the iframe, so no state is left over from the previous sample |
| `demo/catalog.ts` | The shell's list, built from `screens.ts` and `fixtures/cards.ts` |
| `demo/screens.ts` / `demo/views.ts` | The names of the screens and states that can be opened / how each one is opened (swapping the mock, driving the store, the utterance to send) |
| `demo/pages/Gallery.tsx` | The card sample page. It lays the app's cards out at s / m / l / focus |
| `demo/api.ts` | The mock of `RendererApi`. Behavior only; it holds no data |
| `demo/fixtures/*.ts` | The fixed data, one file per area. The tests import it too |
| `demo/fixtures/cards.ts` | One sample of every card type. The card sample page and `/g1` through `/g4` use the same ones |
| `demo/sayings.ts` | Utterance → the card to show and the reply. Utterances are interpreted by `demo/matcher.ts`, a rule that exists only in the demo (in the app the LLM decides) |

| URL | What it shows |
| --- | --- |
| `/` | The shell. This is where a person starts looking around, at `http://localhost:5174/` after `npm run demo`. The list on the left can be filtered |
| `/screens/calendar` `/screens/settings/voice` … | The shell plus the app opened on that screen and state. First-run setup (`setup`, `setup/key-failed`, `setup/mic-denied`, `setup/tts-missing`), booting and a failed boot (`boot`, `boot/error`), the approval confirmation (`confirm`) and the notifications (`toasts`) can be opened too. The names are in `demo/screens.ts` |
| `/screens/setup?size=l` | Shows it at a fixed app window size (l / m / s; the values are in `demo/window-sizes.json`, the same ones the capture tools use). If it does not fit the frame, it is scaled down |
| `/preview/screens/calendar/event?lang=en-US` | Opens it with the interface in that language, spelled as `UI_LOCALES` spells it; without `lang` it is Japanese. The shell's language picker sets the same parameter. The conversation stays Japanese, which the sample data is written in, and the region follows the interface, so dates, times and numbers read as they do for someone who uses that language. Use it to capture one screen in one language; `demo:fit` checks every language at once |
| `/preview/cards?type=weather&theme=pop` | Draws it in that theme (`THEMES` in `src/shared/themes.ts`); without `theme` it is `future`. The shell's theme picker sets the same parameter, and it combines with `lang`. future's values live in `src/renderer/src/assets/themes.css` and each other theme's in `src/renderer/src/assets/themes/<name>/theme.css` |
| `/cards` `/cards/files-pdf` | The shell plus the card samples, all of them or one. The name is the card type, or `type-variant` when one type has several samples (`variant` in `fixtures/cards.ts`). The dotted frame is the height limit, and the bottom edge turns red when a card overflows |
| `/cards/fx-error` | Samples of loading, failure, stale data and a rendering exception (`fx-loading`, `fx-error`, `fx-stale`, `map-crash`). Use them to check what the shell draws |
| `/preview/screens/…` `/preview/cards/…` | What the shell shows in its iframe: the shell's URL with `/preview` in front. **Capture and measurement open these directly** (through the shell, `--cards` and `--rect` do not reach the content) |
| `/preview/cards?type=fx` | Narrows it to one type. Capture this when comparing proposals |
| `/app` | The app without the shell, driven by typing. The default location for `demo:open` and `demo:drive --launch` |
| `/app?say=ドル円のレートを教えて&say=長野県の今日の天気を教えて` | Sends the utterances in order at startup and shows cards on the left and right |

To see a new card or screen in the demo, add data to `fixtures/`; for a card, add one entry to `fixtures/cards.ts` and the utterance mapping to `sayings.ts`. For a screen, add the name to `screens.ts` and how to open it to `views.ts` (the shell's list and the URL follow from there).

## Tools

| Command | Role |
| --- | --- |
| `npm run demo` | Serves the demo on 5174 for a person and the browser pane. The scripts do not need it |
| `npm run demo:open -- [--url path] [--size l] [--say text]...` | Serves the demo, opens it in headless Chrome and keeps both open while iterating. It prints the Chrome port to give `demo:drive --port` |
| `npm run demo:drive -- --launch\|--port <port> [--url path] steps...` | Runs the steps in order and measures as it goes. `--launch` serves the demo and opens Chrome for this run alone; `--port` attaches to the Chrome `demo:open` printed, or to `9222`, the app started by install-mac-app or install-windows-app with `--launch --cdp` |
| `npm run demo:cards -- [output directory] [--say text]...` | A scene. Shows the cards, captures them at l / m / s and checks that they fit |
| `npm run demo:gallery -- [output directory] [--type kind]... [--theme name]` | A scene. Captures the card list in one tall image, in the theme named |
| `npm run demo:setup -- [output directory]` | A scene. Walks first-run setup from start to finish and captures each screen, including the branches (a key that fails to authenticate, text only, a denied microphone). The mock advances the state as it is driven (`demo/setup-demo.ts`) |
| `npm run demo:docs-shots -- [output directory]` | A scene. Writes the screenshots the README and the documentation show, in Japanese and English, in the `simple` theme at 1440x900 captured at 2x, as WebP under `website/public/screens/<ja\|en>/` by default: the gallery (`home`, `calendar`, `agent`, `memory`, `mail`), one image per step of first-run setup once the step is done, the failed key and the denied microphone, and five pages of the settings. It presses a button by the text of a dictionary key in the language the page shows (`window.demoText(key, values)` in `demo/index.tsx`), so the same steps run in every language. Only the interface language changes; the sample data stays Japanese. Run it again whenever the look of these screens changes |
| `npm run demo:fit -- [--cards \| --screens] [--theme name]... [--shard k/n] [locale]...` | A scene that tells whether the text fits in each language of the interface and each theme, since a theme may change the type of the headings. With no locale it checks all eleven, with no `--theme` every theme, and with no flag both cards and screens, so plain `npm run demo:fit` is the full check; name locales (`ja-JP en-US`, as `UI_LOCALES` spells them) only to narrow it. Cards: every sample at s / m / l / focus, reporting a card that is too tall, text past the edge of its card and text cut short; Japanese in the `future` theme is the baseline, so only what differs from it at the same place is reported. Screens: every screen of the demo, reporting a control (button, link, chip, tab, select) that wraps, is cut short or passes the box that clips it, and any text hidden behind such a box; these are judged without a baseline, in Japanese too. A control that shows the user's data instead of a label, such as a calendar event block, carries `data-fit="data"` and is skipped, because its text is cut short on purpose. Each page is loaded once and the language is changed in place, the screens are split across three Chromes, and what only paints is turned off, so the full check of every theme and language takes about 35 seconds; run it after changing the text of the dictionary or a layout. What it finds is measured again a second later and reported only if it is still there, once for all the themes and languages it appeared in, with a 2x capture of it (a temporary folder locally, the `fit-shots` artifact on CI, where the findings also go to the run's summary). When everything fits it prints three lines. It is not part of `npm test`, but CI runs it on every push and pull request, on two machines at once with `--shard 1/2` and `--shard 2/2`, each taking every second theme. Exit code 2 when there is a finding |

`demo:drive` runs its steps in the order they are written.

| Step | Meaning |
| --- | --- |
| `--say text` | Types an utterance and waits for the response to finish. Against the app, this uses the real APIs |
| `--click selector` / `--key Escape` | Clicks an element; presses a key |
| `--goto path` | Navigates to a page of the demo the run is on (`/preview/screens/calendar`, for instance). A full URL works too |
| `--size l\|m\|s\|1280x720` | Pretends the window has that size. For the demo only, never for the app's own window |
| `--fit selector` | Grows the window to that element's content height, for capturing a tall page in one image |
| `--eval expression` | Evaluates JS and records the result. Use it to break down `getComputedStyle` or `offsetHeight` |
| `--rect selector` | Records the position and size of the matching elements |
| `--cards` | Records each card's size, natural height and clipping. Exits with code 2 when a card does not fit |
| `--shot name` | Writes a PNG under `--out directory`, or a WebP at quality 85 when the name ends in `.webp` |

Example: capture how s looks while measuring the breakdown of the top of the exchange rate card.

```bash
npm run demo:open -- --say "ドル円のレートを教えて" &   # prints "ready: port <port> …"
npm run demo:drive -- --port <port> --size s --cards --rect ".card-hero" --rect ".fx-table" --out /tmp/shots --shot fx-s
```

## How to iterate

1. Capture once before you change anything, so you can compare the two side by side later.
2. Start `npm run demo:open` in the background and note the port it prints.
3. Edit the CSS or the TSX. Vite's HMR carries the change into the open page, so re-issue `npm run demo:drive -- --port <port> ...` and look at the numbers. Repeat until the numbers are right, then stop `demo:open`.
4. To finish, produce the images with a one-off capture (`demo:cards`, `demo:gallery`, `demo:drive --launch --shot`) and always look at them yourself. Even when the numbers are right, spacing, cramped text and overlap show up only in the image.
5. To check in the app itself, install and launch it with `--launch --cdp` of install-mac-app (or install-windows-app on Windows) and then use `npm run demo:drive -- --port 9222 --say ... --out ... --shot app`.
6. The report says what you measured at which window size and how it changed, carries the images, and states what you did not check.

## Adding a scene

When you capture the same steps over and over, make them a scene. Copy `scripts/cdp/scenes/cards.mjs` or `gallery.mjs`, rewrite the array of steps, and add `demo:<name>` to `package.json`. A scene only calls `main(steps, options)` from `drive.mjs`, so the output format and the exit codes stay the same. For the calendar screen, for instance, express it as steps: open `/preview/screens/calendar` with `--goto`, switch between month, week and list with `--click`, and `--shot` each one.

## Pitfalls

- With Chrome's `--screenshot` and `--virtual-time-budget`, motion's entrance animation does not run and cards come out transparent. Use `drive.mjs`, which waits in real time.
- The overflow check runs once things have settled for 250ms (`OVERFLOW_SETTLE_MS`). Measuring right after changing `--size` picks up a momentary value, so the script waits 1.2 seconds.
- When typing by hand in the browser pane, send with Enter (Return does not send). Capturing immediately after an action inside a batch is one step behind.
- The browser pane's images are scaled down. Capture with the scripts any image you will use to judge font sizes or cramped text.
- The dock holds one card on each side, so three or more of the same type cannot be shown at once. Use the card samples (`/preview/cards?type=…`) to compare proposals side by side.
- Do not put these captures in GitHub Actions. Chrome on Linux has different fonts, heights shift by tens of pixels, and the check becomes unreliable.
