---
name: website
description: How to change, check and publish ASIST's website at asist-agent.com (website/, the landing page and the Starlight documentation, served by a Cloudflare Worker), with the Cloudflare login kept inside this repository. Use when asked to edit, preview, build, deploy, publish or roll back the website, the landing page or the documentation, to write or translate a documentation page, or when a change to the app alters what a user sees or does (紹介ページ、LP、サイト、ドキュメント、docs、使い方のページ、翻訳、asist-agent.com、デプロイして、公開して、サイトに反映して、Cloudflare、wrangler), or when wrangler reports the wrong account or no login. Do not use for the app's own screens (visual-debugging) or for rebuilding the promotional video, which only reads the website's images.
---

# The website

`website/` is a separate npm project, apart from the app's dependencies and CI. It holds the landing page (`src/pages/`) and the documentation for users (Starlight, `src/content/docs/`). Astro builds both into static HTML in `website/dist`, and the Worker `asist-website` (`website/wrangler.jsonc`) serves it at asist-agent.com as static assets, with no script. The Worker `asist-website-www` (`website/www/`) sends www.asist-agent.com there with a 301. Keep a script out of `asist-website`: every request that runs one, each image and stylesheet included, counts towards the free plan's 100,000 a day, past which the site fails until the next day, while asset requests are free and unlimited. The domain and its DNS are on the same Cloudflare account.

## 1. Change and look

```bash
npm --prefix website install   # once per checkout, and after website/package.json changes
npm run website                # http://localhost:5194
npm run website:build          # website/dist, then checks every internal link, image and #anchor
```

The landing page is `website/src/components/Landing.astro`, its style `website/src/styles/landing.css`.

- Look at the page at desktop width and at phone width (about 390 px). Sections appear on scroll (`data-in`), so scroll to what you changed before judging it.
- The dev server listens on this computer only. To open it from a phone, start it with `npm run website -- --host` for the check alone: that serves it on every network the computer is on, including shared Wi-Fi.
- Pictures in `website/public/` are also used by the promotional video (`promotions/launch-video/`), and `website/og/art.png` by its YouTube thumbnail. When one changes, say so in the report, since the next video or thumbnail changes with it.
- A change reaches main through a pull request like any other (`pull-request`). Publish from main, never from a branch.

## 2. Write the documentation

- Japanese pages are in `src/content/docs/docs/` (served at `/docs/`), English pages in `src/content/docs/en/docs/` (at `/en/docs/`), with the same file names. Japanese is written first; a change to a Japanese page changes the English page in the same pull request. A page missing in English shows the Japanese one with a notice, so never leave one out.
- The sidebar lists each chapter folder in `astro.config.mjs` and orders pages by `sidebar.order` in their frontmatter.
- Quote a button, page or setting exactly as the app shows it: the `ja-JP` and `en-US` values of its key in `src/shared/i18n/messages/`.
- A heading another page links to keeps its text; changing it breaks the `#anchor`, which the build then reports.
- ASIST runs on macOS and Windows, and every page is written for both. Where a sentence or two differ, name each system in the sentence ("… on a Mac, and … on Windows"). Where the steps differ, put them in Starlight's tabs with `syncKey="os"`, so that the system a reader picks stays picked on every page:

  ```mdx
  import { Tabs, TabItem } from '@astrojs/starlight/components'

  <Tabs syncKey="os">
  <TabItem label="macOS">

  1. …

  </TabItem>
  <TabItem label="Windows">

  1. …

  </TabItem>
  </Tabs>
  ```

  - The labels are `macOS` and `Windows`, in that order and spelled the same in both languages, since the tabs of every page are matched by label. A page with tabs is `.mdx`.
  - Write `<TabItem>` and `</TabItem>` at the start of the line with a blank line inside. satteri 0.10.5, Astro's MDX parser, panics with "byte index … is not a char boundary" or "out of bounds" when an indented closing tag follows a list (2026-09-27).
  - Keep headings outside the tabs: a heading inside one still appears in the table of contents when the other tab is shown.
  - Say plainly what one system does not have (on Windows, the calendar and Qwen3-TTS) on the page of that feature, rather than leaving it out.
  - The app words some screens differently on each system; quote the `.macos` or `.windows` key of the dictionary in its tab.
- Screens of the app come from the demo: `npm run demo:docs-shots` writes them to `public/screens/{ja,en}/`. Pages refer to `/screens/ja/…` and `/screens/en/…`. Write the Japanese in plain words (see the `ui-text` skill's writing guide).
- The languages of the site, and which of them have a landing page or documentation, are listed once in `src/i18n/languages.mjs`.
- The landing page is `src/components/Landing.astro`, and its text in each language is `src/i18n/landing/<code>.ts` (Japanese first, with the `LandingText` shape). A language appears once it is marked `landing: true` in `languages.mjs` and registered in `src/i18n/landing/index.ts`; its header menu, hreflang links and page follow from that. A language without documentation links to the English documentation. Social sites get `public/img/og.png` for Japanese and `og-en.png` for the rest (`node website/og/render.mjs [en]`).
- The dev server keeps the old sidebar after pages are moved or renamed; restart it.

## 3. Log in (once per checkout)

Always run wrangler as `npm run cf -- <command>`, never `npx wrangler`. `scripts/wrangler.mjs` points wrangler at a login stored in `.wrangler/config` of this checkout, so the account wrangler uses elsewhere on this computer is never touched. It removes `CLOUDFLARE_API_TOKEN` and the other `CLOUDFLARE_*` variables, which would take precedence over the login, and it stops when `~/.wrangler` exists, since wrangler would then read that login instead.

```bash
npm run cf -- whoami
```

- "You are not authenticated": ask the user to run `npm run cf -- login` and sign in, in the browser, with the Cloudflare account that holds asist-agent.com. You cannot sign in for them.
- Check that the account id `whoami` prints is the `account_id` in `website/wrangler.jsonc`. If it differs, stop and ask; deploying would create the Worker in the wrong account.
- A git worktree has its own `.wrangler/`, so it needs its own login. Publishing from the main checkout avoids that.

## 4. Publish

Publishing changes a public site, so do it only when the user has asked for it.

```bash
git switch main && git pull --ff-only
npm run website:deploy   # builds website/dist, deploys the www redirect and then the site
```

Then check the live site, not the build:

```bash
curl -sI https://asist-agent.com/ | head -1                           # 200
curl -sI https://www.asist-agent.com/img/hero.png | grep -i -E '^(HTTP|location)'   # 301 to https://asist-agent.com/img/hero.png
curl -s https://asist-agent.com/ | grep -c '<the text you changed>'
```

Open https://asist-agent.com/ in the browser pane as well and look at what changed. Report the commit you published and what you saw.

## 5. Undo a publication

```bash
npm run cf -- deployments list --config website/wrangler.jsonc
npm run cf -- rollback <version-id> --config website/wrangler.jsonc
```

A rollback only changes what is served. Fix main afterwards through a pull request, or the next deploy brings the problem back.

## Notes

- Astro's build drops an individual `translate`, `rotate` or `scale` property that shares a rule with `transform`, without a warning (Astro 7.3, 2026-09-25). Put all of it in `transform` in such a rule. A change to the CSS is safest checked against the published page: capture both at the same width and compare the pixels.

- `npm run cf -- deploy --config website/wrangler.jsonc --dry-run` (and the same with `website/www/wrangler.jsonc`) checks the configuration without logging in.
- `npm run cf -- dev --config website/www/wrangler.jsonc` runs the www redirect locally; any request to it answers with a 301 to the same path on asist-agent.com.
