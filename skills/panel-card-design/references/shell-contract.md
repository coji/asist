# The contract between the shell and a card

As of 2026-09-15. When you change a value, fix this document and the comments in `src/renderer/src/panels/shell/card.ts` at the same time.

## Contents

1. Sizes and heights
2. The card definition (CardDefinition)
3. What the shell provides
4. The body box and how overflow is handled
5. Layout numbers
6. Checking in the demo

## 1. Sizes and heights

There are four sizes: `s`, `m`, `l`, and `focus`, the enlarged view in the center. `Dock` decides from the height inside the dock (its height without the padding), and because the left and right docks are the same height, the cards on both sides get the same size.

| Size | Condition | Height the card must fit in |
| --- | --- | --- |
| s | The dock's inside is under 625px | 520px or less (from the roughly 540px left in the dock at the 640px minimum window) |
| m | The dock's inside is 625px or more | 625px or less |
| l | The dock's inside is 720px or more | 720px or less |
| focus | The enlarged view | No limit. It scrolls inside 82vh |

The constants are `CARD_SIZE_MIN_HEIGHT = { m: 625, l: 720 }` and `CARD_S_MAX_HEIGHT = 520`. Measured in the demo, the weather card's natural height is 689px at l, 604px at m and 471px at s, and even with the extra line shown when part of the fetch fails (about 19px) it stays within each limit.

Roughly how much height is left inside the dock on each setup. Maximized assumes the menu bar and the macOS Dock are visible; the value is what remains after subtracting the top bar (78px when the window is 860px tall or less, 92px above that) and the dock's 18px of padding.

| Setup | Window height | Inside the dock | Size |
| --- | --- | --- | --- |
| Minimum window | 640 | about 540 | s |
| 1440×900 maximized | 828 | 728 | l |
| MacBook Air 13-inch maximized | about 845 | about 745 | l |
| MacBook Pro 14-inch maximized | about 871 | about 757 | l |
| External 1080p maximized | about 982 | about 868 | l |
| MacBook Pro 16-inch maximized | about 1006 | about 892 | l |

On Windows the window has no title bar of its own, so a maximized window's page takes the whole work area: the screen's height in CSS px less the 48px taskbar. Measured on Windows 11 on a 1512×949 screen (2026-09-27): a page 901px tall and 791px inside the dock. The rest follow from the same subtraction, and a display scale of 150% on a 1080p screen, common on laptops, falls to s.

| Setup (Windows 11) | Window height | Inside the dock | Size |
| --- | --- | --- | --- |
| 1920×1080 at 100%, maximized | 1032 | 922 | l |
| 1920×1080 at 125%, maximized | 816 | 720 | l, at its lower edge |
| 1920×1200 at 150%, maximized | 752 | 656 | m |
| 1920×1080 at 150%, maximized | 672 | 576 | s |
| 2560×1440 at 150%, maximized | 912 | 802 | l |

## 2. The card definition (CardDefinition)

The type in `src/renderer/src/panels/shell/card.ts`. It is registered in `registry.tsx` as `type → CardDefinition`.

| Field | Type | Role |
| --- | --- | --- |
| `Body` | `React.FC<{ spec: PanelSpec; size: CardSurfaceSize }>` | The body. It draws only inside the box and the size the shell gave it. Put `data-size={size}` on the root element |
| `kicker` | `string` | The heading at the top left. In the focus view it becomes "<kicker> · FOCUS" |
| `className` | `string?` | The class put on the card's frame (`.panel-card` and `.panel-focus`). Override the CSS variables here |
| `meta` | `(context) => ReactNode` | The note shown at the right of the header, to the left of the expand and close buttons. Called only when the data is there (ready / stale) |
| `backdrop` | `(context) => ReactNode` | The background laid across the whole card. It extends under the header and is drawn behind the body. Called only for ready / stale |
| `scroll` | `boolean?` | True for a card whose content has no fixed length. What does not fit scrolls inside, and the bottom edge is faded |

`context` is `{ spec, size }`. A body that can be drawn from props alone is wrapped with `fromProps` (`src/renderer/src/panels/shell/from-props.tsx`) in the card's own module.

## 3. What the shell provides

The CSS variables a card sets from the class in `className`. The frame's border, background and shadow are not
among them: the theme derives them from the hue (`src/renderer/src/assets/themes.css`, and the `theme` skill).

| Variable | Default | Purpose |
| --- | --- | --- |
| `--card-hue` | `#538cc5` | The card's own tint, one colour. Each theme makes the frame and `--card-accent` from it |
| `--card-focus-width` | `760px` | The upper bound on the focus view's width (`min(92vw, this value)`) |

Inside the card, `--card-accent` is the hue adjusted to the theme, and `--card-background` the frame's colour, which a
backdrop fades into. Every other colour is a theme token (`--ui-*`, `--color-holo-*`); a card writes no colour itself.

Attributes. The card's frame (`.panel-card` / `.panel-focus`) carries `data-panel-type` and `data-size`. The body also receives `size` as a prop, so decide what to change in the DOM (whether to show a section, or a row leading to the focus view) from the prop, and handle padding and font sizes through the `data-size` on your own root element.

Structure.

```text
.panel-card[data-size]        The frame. Column flex, max-height: 100%, padding 16, gap 10
  .panel-backdrop             The backdrop, if there is one. absolute inset 0, z-index -1
  .panel-head                 kicker / meta / expand / close. 17px tall
  .panel-body                 The box for the body. flex 1, min-height 0, overflow clip, contain layout paint
    .panel-body-inner         The body's natural height. The stale note, the Body and the source stacked with gap 10
```

The focus view has the same structure, except that `.panel-body` drops the clip and the whole overlay scrolls.

## 4. The body box and how overflow is handled

`CardBox` in `PanelContent` watches `.panel-body` and `.panel-body-inner` with a ResizeObserver and treats `inner.offsetHeight > box.clientHeight + 1` as overflow. While the window is being resized the content overflows for a moment until the size switches, so the check waits `OVERFLOW_SETTLE_MS` (250ms) for things to settle.

| Card | When it overflows |
| --- | --- |
| `scroll: true` | `data-clipped="scroll"`. The content scrolls inside, and the bottom 28px is faded to show that there is more |
| Everything else | `console.error("card does not fit: <type> size=<size> content <n>px > box <m>px")`. During development, `data-clipped="error"` puts a red outline along the bottom edge |

Fix overflow as a design defect. Do not escape it by raising the threshold.

## 5. Layout numbers

- `.dock` has 8px of padding at the top and 10px at the bottom. The height inside the dock = the dock's clientHeight − 18.
- A card's natural height = 16 (padding) + 17 (head) + 10 (gap) + the body's natural height + 16 (padding). The height available to the body = the dock's inside − 59.
- The navigation at the bottom is absolutely positioned inside `.app-shell`, and only the center column (`.stage`) and the workspace screens (`.main.is-workspace`) carry `--nav-space` (110px, or 98px when the window is 860px tall or less) as bottom padding. The left and right docks run to the bottom of the window.
- The minimum window is `minHeight: 640` in `src/main/index.ts`. The 520px upper bound for s follows from that.

## 6. Checking in the demo

The demo (`scripts/vite.demo.config.mts`) runs the renderer in a plain browser; the scripts serve their own copy for each run, and `npm run demo` serves one on 5174 for a person. There is no `window.api`, so `src/renderer/src/demo/api.ts` answers instead. How to use the tools is in the `visual-debugging` skill.

- `/app?say=<utterance>&say=<utterance>` sends the utterances in order at startup. The weather card appears for an utterance containing 「天気」 ("weather"); which place and day it shows is decided by `demoWeatherFor` in `src/renderer/src/demo/fixtures/weather.ts` (the utterances are matched in `src/renderer/src/demo/sayings.ts`).
- `npm run demo:cards -- <output directory> [--say text]... [--sizes l,m,s]` drives headless Chrome over CDP and captures at 1440×828, 1440×740 and 1440×640. It writes each size's natural card height, `data-size` and `clipped` into `card-sizes.json`, and exits with code 2 when a size is wrong or something overflows.
- `npm run demo:drive -- --launch|--port <port> --cards` measures the cards on the screen it is on. Combine it with `--size` to iterate.
- Sending `/g1` through `/g4` shows every card type in turn, as a gallery.
