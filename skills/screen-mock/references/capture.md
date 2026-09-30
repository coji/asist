# Capturing and showing

The tools are `scripts/cdp/` from the `visual-debugging` skill. This file covers only the combinations used for mocks.

## Capturing

```bash
OUT=/path/to/scratch/mock-settings
npm run demo:drive -- --launch --size 1440x900 \
  --goto /preview/screens/settings --shot page-overview \
  --click '.st-nav[data-page="voice"]' --shot page-voice \
  --click '.st-nav[data-page="memory"]' --shot page-memory \
  --out "$OUT"
```

- `--launch` serves this checkout's demo and opens headless Chrome for the one run, and closes both again.
  While iterating it is faster to leave `npm run demo:open -- --url /preview/screens/settings` running and
  re-issue commands against the same screen with `--port <the port it printed>`.
- For a tall page, use `--fit "<the scrolling element>"` to grow the window to the content height and capture it in one image.
- Produce the states (empty, loading, failed) from what the demo's mock (`src/renderer/src/demo/api.ts`) returns. Do not use the real services.
- The images come out at 2x resolution. Always open and look at them. Look for cramped text, wrapped lines, and chips or buttons whose heights do not line up.

## Showing

Send the images with `SendUserFile` (all at once if there are several). The user reads Japanese, so write the
accompanying message in Japanese, in this shape:

```
<画面名> のモックです(demo の固定データ)。
- 変えた構成: …(二〜三行)
- 固定データの部分: …(実装では main から来る)
- 決めてほしいこと:
  1. …
  2. …
- 触ったファイル: …(戻すときはこの一覧を git checkout する)
```

## After approval

1. `npm run typecheck` and `npm test`.
2. Add tests for the screen (the order of the items, switching, how the states are shown, and that saving reaches main).
3. Commit. If the usage in README changes, fix it.
