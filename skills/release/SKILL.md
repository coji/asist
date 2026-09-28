---
name: release
description: How to release a new version of ASIST from this Mac - choosing the version number, the pull request that raises it, the checks before a release, running npm run release (signing, notarization, the Windows installer built by the windows-release workflow, the GitHub release), checking the published release as a user meets it, and publishing the documentation that goes with it. Use when asked to release, ship or publish a version (リリースして、新しいバージョンを出して、0.1.1 を出して、配布して、公開して、バージョンを上げて), when a release failed, is stuck in notarization or in the Windows workflow, or when asked whether a published version is correct. Do not use for installing a build on this Mac only (install-mac-app) or on Windows (install-windows-app), or for a website change without a release (website).
---

# Releasing a version

A release is one GitHub release of `nyosegawa/asist` with both apps built from the same commit of main: the Mac
app notarized and signed with the Developer ID Application certificate (`Masaki Hayashi (23ALBNP2KW)`) on this
Mac, and the unsigned Windows installer built by `.github/workflows/windows-release.yml` on GitHub Actions. The
installed apps on both systems download it by themselves and install it at their next quit, so everything
published reaches every user, and a published version is never withdrawn. What `npm run release` checks and
does is in `docs/development.md` (「リリースする」); the reasons, and the risk of updating an unsigned Windows
app, are in
`docs/adr/0026-mac-releases-are-signed-with-developer-id-windows-releases-are-unsigned-and-updates-install-at-the-next-quit.md`.

Publishing is outward-facing: ask the user before step 4 and name the version and what it contains.

## 1. Choose the version

While the version is below 1.0:

- A release that adds or changes a feature raises the middle number and resets the last: 0.1.3 → 0.2.0.
- A release that only fixes defects raises the last number: 0.1.0 → 0.1.1.
- Going to 1.0 is the user's decision.

List what main has gained since the last release to decide, and to tell the user what the release contains:

```bash
git log --oneline "v$(node -p 'require("./package.json").version')"..origin/main
```

## 2. Raise the version

A pull request of its own, through the `pull-request` skill, titled `Raise the version to <version>`:

```bash
npm version <version> --no-git-tag-version
```

It changes `package.json` and `package-lock.json`. Merge it once CI passes.

## 3. Check the build of main

Install main with `install-mac-app`, and on the Windows machine with `install-windows-app`, and go through the
items of 「実機での確認」 in `docs/development.md` that the changes since the last release touch. Write in the report which items were checked and which were not.
A defect found here is fixed before the release, not after it.

## 4. Release

On main, clean and equal to origin/main, run it in the background; it takes 20 to 60 minutes:

```bash
npm run release > /tmp/asist-release.log 2>&1
```

- The screen must stay unlocked until it ends. notarytool reads its credentials from the keychain, and while
  the screen is locked it fails with `No Keychain password item found for profile: asist-notary`. Keep the
  display awake for as long as the release runs: `caffeinate -d -i -w <pid of node scripts/release.mjs>`.
  A lock the user makes by hand still stops it, so tell them.
- Notarization is the long wait. The first submission of the team took 35 minutes (2026-09-28); later ones
  took a few minutes. `xcrun notarytool history --keychain-profile asist-notary` shows what Apple is doing.
- A keychain dialog asking for the login password on behalf of codesign means the key has not been allowed
  for codesign yet: the user types the password and presses 「常に許可」 (Always Allow).
- Once the draft release with the Mac files exists, the script dispatches `windows-release.yml` with the tag
  and the commit and waits for it with `gh run watch --exit-status`. The run has three jobs. `draft` checks
  that the release is a draft made from that commit. `build`, on windows-latest with a token that can only
  read, checks that `package.json` has the tag's version, builds the NSIS installer with the three repository
  secrets (`RENDERER_VITE_GOOGLE_MAPS_EMBED_KEY`, `ASIST_GOOGLE_CLIENT_ID`, `ASIST_GOOGLE_CLIENT_SECRET`),
  checks `app-update.yml` and `latest.yml`, and hands the files over as a workflow artifact kept for a day.
  `upload` runs no npm and no project code: it checks the draft again and uploads `ASIST-Setup-x64.exe`, its
  blockmap, `latest.yml` and `git-for-windows-<version>.tar.gz` with gh. The unpacked Windows build takes about
  3 minutes in CI (2026-09-28); the installer adds its compression, and `build` stops after 60 minutes. The
  script publishes only when the draft has every Windows file.

## 5. Check what was published

```bash
node skills/release/scripts/verify-release.mjs <version>
```

It downloads the dmg and `latest-mac.yml` from `releases/latest` as a user would, compares the dmg with
the digest the feed lists, marks it as downloaded, and asks Gatekeeper about the app inside. It also downloads
`ASIST-Setup-x64.exe` and `latest.yml` and compares the installer with the digest and size the feed lists; the
installer itself is checked on Windows (`install-windows-app`). Every line must say `ok`.

The first update between two published versions is seen only on a machine that runs the previous release:
open 「このアプリについて」 there, on a Mac and on Windows, and see the new version downloaded and ready. On
Windows, quit from the tray and open the app again, then see the new version on the same page.

## 6. Publish the documentation

When the documentation changed since the last release, deploy the website now, with the `website` skill.
Until then the site describes the previous version, which is what the users still run.

## When something goes wrong

- A failure before `gh release create` publishes nothing: fix the cause and run `npm run release` again.
- A failure after it leaves a draft release, which no user sees. A second `npm run release` stops, says that a
  draft of the version is left, and prints the commands to finish it (the Windows workflow, then publishing)
  or to delete it. Show the user the draft (`gh release view v<version> --repo nyosegawa/asist`); finish it
  when only the Windows files are missing, or delete it only when they agree and run again.
- Notarization rejected: read the log Apple returns
  (`xcrun notarytool log <submission id> --keychain-profile asist-notary`) and fix what it names.
- The Windows workflow failed: the script stops, prints the run and leaves the draft unpublished. Read the
  failed steps with `gh run view <run id> --repo nyosegawa/asist --log-failed`. When the cause is outside the
  code (a missing secret, the runner, the network), add Windows to the draft by hand, as below. When the code
  has to change, delete the draft once the user agrees, merge the fix and run `npm run release` again.
- Adding Windows to a draft by hand, with the tag and the commit the draft was made from
  (`gh release view v<version> --repo nyosegawa/asist --json targetCommitish`):

  ```bash
  gh workflow run windows-release.yml --repo nyosegawa/asist --ref main -f tag=v<version> -f commit=<sha>
  gh run watch <run id> --repo nyosegawa/asist --exit-status   # the run id is in the URL the first command prints
  gh release view v<version> --repo nyosegawa/asist --json assets --jq '.assets[].name'
  gh release edit v<version> --repo nyosegawa/asist --draft=false --latest   # only with the user's go-ahead
  ```

  The workflow refuses a release that is already published, so a published release that lacks Windows,
  0.1.0 among them, stays as it is; Windows comes with the next version.
- A defect in a published version is fixed with the next version. Do not delete a published release or
  move its tag: electron-updater installs only a higher version, so there is no way back for the users.
