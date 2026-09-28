---
name: release
description: How to release a new version of ASIST from this Mac - choosing the version number, the pull request that raises it, the checks before a release, running npm run release (signing, notarization, the GitHub release), checking the published release as a user meets it, and publishing the documentation that goes with it. Use when asked to release, ship or publish a version (リリースして、新しいバージョンを出して、0.1.1 を出して、配布して、公開して、バージョンを上げて), when a release failed or is stuck in notarization, or when asked whether a published version is correct. Do not use for installing a build on this Mac only (install-mac-app) or on Windows (install-windows-app), or for a website change without a release (website).
---

# Releasing a version

A release is a notarized build of main, signed with the Developer ID Application certificate
(`Masaki Hayashi (23ALBNP2KW)`), on the GitHub releases of `nyosegawa/asist`. The installed apps download
it by themselves and install it at their next quit, so everything published reaches every user, and a
published version is never withdrawn. What `npm run release` checks and does is in `docs/development.md`
(「Mac のアプリをリリースする」); the reasons are in
`docs/adr/0026-releases-are-signed-with-developer-id-and-updates-install-at-the-next-quit.md`. For now a release carries the Mac app
only.

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

Install main with `install-mac-app` and go through the items of 「実機での確認」 in `docs/development.md` that
the changes since the last release touch. Write in the report which items were checked and which were not.
A defect found here is fixed before the release, not after it.

## 4. Release

On main, clean and equal to origin/main, run it in the background; it takes 10 to 40 minutes:

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

## 5. Check what was published

```bash
node skills/release/scripts/verify-release.mjs <version>
```

It downloads the dmg and `latest-mac.yml` from `releases/latest` as a user would, compares the dmg with
the digest the feed lists, marks it as downloaded, and asks Gatekeeper about the app inside. Every line
must say `ok`.

The first update between two published versions is seen only on a Mac that runs the previous release: open
「このアプリについて」 there and see the new version downloaded and ready.

## 6. Publish the documentation

When the documentation changed since the last release, deploy the website now, with the `website` skill.
Until then the site describes the previous version, which is what the users still run.

## When something goes wrong

- A failure before `gh release create` publishes nothing: fix the cause and run `npm run release` again.
- A failure after it leaves a draft release, which no user sees, and a second run stops at "already
  released". Show the user the draft (`gh release view v<version> --repo nyosegawa/asist`) and delete it
  only when they agree, then run again.
- Notarization rejected: read the log Apple returns
  (`xcrun notarytool log <submission id> --keychain-profile asist-notary`) and fix what it names.
- A defect in a published version is fixed with the next version. Do not delete a published release or
  move its tag: electron-updater installs only a higher version, so there is no way back for the users.
