---
name: install-mac-app
description: How to build a signed ASIST on this Mac, put it in /Applications, launch it with logging, and check it on the real machine. Use when the user asks to install, deploy, or update the app on this Mac (インストールして、/Applications に入れて、実機に反映して、署名ビルド、dist:mac、本番アプリを更新), asks whether the installed app is current, or wants the installed app driven over CDP for a screenshot or log check. Do not use for the browser demo (renderer only) or for unit tests.
---

# Installing on this Mac

A change counts as finished only when it has gone all the way through: implement, build signed, overwrite /Applications, check on the real machine from the app's log, and quit the app you launched. Microphone permission (TCC) does not stick for an unsigned build, so always sign.

## Steps

1. Get the prerequisites in place. `npm run typecheck` and `npm test` pass, and the change you want to install is committed. Note the short commit hash and write it in your report.
2. Check what is already installed. Compare the modification time of `/Applications/ASIST.app/Contents/MacOS/ASIST` with the time of the change you want to install. If it is already newer, there is no need to reinstall.
3. Build and install. This takes several minutes, so run it in the background.

   ```bash
   sh skills/install-mac-app/scripts/install.sh --build --replace-running --launch --cdp
   ```

   - `--build` checks that the signing identity exists and then runs `npm run dist:mac`. Without it, the existing build at `dist/mac-arm64/ASIST.app` is used.
   - `--replace-running` quits a running ASIST and replaces it. Without it, the script stops when ASIST is running. Even while the user is in the middle of using the app, quitting it is fine once they have asked for an install.
   - `--launch` starts the app afterwards through `open -a` with `--enable-logging` and prints where the log file is. Never start the executable directly from the shell: the microphone permission (TCC) then attaches to the parent shell, and the permission granted to the app stops working. `open` starts it through LaunchServices, so the permission is the app's own, and `--stdout` and `--stderr` capture the log.
   - `--cdp` (only with `--launch`) adds `--remote-debugging-port=9222`, which step 4 connects to. While the port is open, any process on this Mac can drive the app, its preload bridge included, so pass it only for a check and quit the app afterwards (step 5). A launch without it leaves the port closed.
   - When the change alters the format of a file under `~/Library/Application Support/asist/` that the app reads at startup (`settings.json`, `memory-curation.json` and the like), leave out `--launch`. The app keeps no migration for an older format and stops at startup on a file it cannot read, so update the real file to the new format first, and only then launch with `sh skills/install-mac-app/scripts/install.sh --launch --cdp` (on 2026-09-23 `memory-curation.json` gained a required `lastFailure`). Read the file before you change it, and say in the report what you changed.
   - The signing identity can be overridden with `CSC_NAME`, given as the part after "Developer ID Application: " (electron-builder stops on a name with that prefix). Without it, the script uses the Developer ID Application identity in the keychain and stops when there is none or more than one. In that case check with `security find-identity -v -p codesigning` and ask the user. The script refuses a build signed otherwise: macOS ties the microphone permission to the signature, and the released app is signed with Developer ID.
   - This build has no dmg or zip, so it carries no `app-update.yml` and never updates itself from a release. Installing a release instead (`npm run release` publishes it) gives the app that does.
4. Check it. Wait about 10 seconds after the launch and look for `Error` or `失敗` in the log. Drive the screen with the `visual-debugging` tools, connected to port 9222 of the app launched with `--cdp`.

   ```bash
   npm run demo:drive -- --port 9222 --say "長野県の今日の天気を教えて" --cards --out /tmp/asist-app --shot weather
   ```

   `--say` uses the real API of the conversation model chosen in the settings, and the real external services, so it costs a turn. Omit it and the run only measures and captures the current screen. The JSON output carries each card's size, height and `clipped`; `clipped` of `error` means the card does not fit. Do not use `--size` on the app's own window.
5. Quit the app when the check is done. The app started with `--launch` opens the microphone by itself and keeps picking up the sound of the room and answering it. What you started for a check ends with the check; whether to keep using it is the user's decision.

   ```bash
   osascript -e 'tell application "ASIST" to quit'
   ```

6. Report. Write the commit you installed, the build time, what you saw in the log, the screens you captured, what you did not check, and that you quit the app.

## Notes

- This shell has no microphone permission, so running `asist-mic` on its own produces silence. Audio can only be checked through the app. For the same reason, starting the app itself directly from the shell leaves it without its microphone permission. Always launch through `open -a`.
- The user sometimes quits or restarts the app themselves while you are checking. When the CDP connection drops, use `pgrep -fl "ASIST.app/Contents/MacOS/ASIST"` to see whether the running instance is theirs, and do not kill it on your own.
- However it is started, the app leaves a daily log file in `~/Library/Logs/asist/` (the main process output, plus warnings and errors from the renderer). Read those for a problem that happened when the user started the app normally. The `--launch` log additionally contains the renderer's info messages and Chromium's output.
- Settings live in `~/Library/Application Support/asist/settings.json`, and memory, jobs and voice models are under the same directory. Installing does not erase them.
- `npm run dist:mac` also builds the native microphone helper, fetches uv and compiles git in `prebuild`. It needs the Xcode command line tools and the network the first time; later builds reuse `resources/uv` and `resources/git` while their pinned versions match.
- The packaged app ignores `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` (the fuses in `electron-builder.yml`), so the main process of the installed app cannot be attached to with a Node debugger. Debug the main process with `npm run dev`; `npx @electron/fuses read --app dist/mac-arm64/ASIST.app` shows the fuses of a build.
- For appearance alone, the demo that does not start Electron (the verification in the `panel-card-design` skill) is usually enough. Use this procedure only when you need to see how the real services behave.
