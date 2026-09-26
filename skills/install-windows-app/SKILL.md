---
name: install-windows-app
description: How to build ASIST on a Windows 11 machine, install it for the current user with its installer, launch it with logging, check it on the real machine over CDP, and quit it. Use when asked to install, deploy or update the app on Windows (Windows に入れて、インストーラーで入れて、実機に反映して、dist:win、Windows のアプリを更新), to check whether the installed Windows app is current, or to drive the installed Windows app over CDP for a screenshot, a notification or a log check. Do not use on a Mac (install-mac-app), for the browser demo, or for unit tests.
---

# Installing on Windows

A change to the app counts as finished on Windows only when it has gone all the way through: build the installer, install it, check it on the real machine from the app's log, and quit the app you launched. The app is not signed yet, so there is no signing step.

Run everything in PowerShell from the root of the checkout on the Windows machine. The commands are Windows commands; from a Mac they reach that machine only through whatever remote shell the session has.

## Steps

1. Get the prerequisites in place. `npm run typecheck` and `npm test` pass, and the change you want to install is committed. Note the short commit hash for the report.
2. Stop a development run first. `npm run dev` and the installed app share `%APPDATA%\asist` and one single-instance lock, so an installed app started while a development run is open quits at once without a word.
3. Build and install. The build takes about three minutes and the install about 30 seconds.

   ```powershell
   node skills/install-windows-app/scripts/install.mjs --build --replace-running --launch --cdp
   ```

   - `--build` runs `npm run dist:win`, which writes `dist\ASIST Setup <version>.exe`. Without it, the installer already in `dist\` is used.
   - `--replace-running` stops a running ASIST first. Without it, the script stops when ASIST is running. Closing the window only hides it and the tray's quit is out of a script's reach, so the app is stopped with `taskkill /F`; its agent CLIs stop with it, through the launcher's job object.
   - The installer runs with `/S`: no window, no administrator rights, into `%LOCALAPPDATA%\Programs\asist`, with a Start menu shortcut. A silent install does not start the app.
   - `--launch` starts `ASIST.exe` and prints where its launch log is (`%TEMP%\asist-<time>.log`, or `ASIST_LOG`). The launch log holds the renderer's console messages and Chromium's own output; the main process writes to the daily log in step 4. The app is started through `Start-Process`, so the command returns at once even from a shell that waits for every process holding its output.
   - `--cdp` (only with `--launch`) adds `--remote-debugging-port=9222`. While the port is open, any process on the machine can drive the app, its preload bridge included, so pass it only for a check and quit afterwards (step 5).
4. Check it. Wait about 10 seconds after the launch and look for `ERROR` or `失敗` in the daily log, `%APPDATA%\asist\logs\<date>.log`. Drive the screen with the `visual-debugging` tools against port 9222:

   ```powershell
   npm run demo:drive -- --port 9222 --out $env:TEMP\asist-app --shot app
   ```

   `--say` uses the real conversation model and services and costs a turn, as on the Mac. The page's `window.api` is the app's own, so a check can call it over CDP, for example `window.api.notify('ASIST', 'test')` to see a notification.
5. Quit the app when the check is done. The app opens the microphone by itself and keeps answering the sound of the room.

   ```powershell
   node skills/install-windows-app/scripts/install.mjs --quit
   ```

6. Report the commit you installed, the build time, what the log showed, the screens you captured, what you did not check, and that you quit the app.

## Notes

- Windows shows a notification only from an app whose AppUserModelID matches its Start menu shortcut, so notifications appear in the installed app and never in `npm run dev`.
- The packaged app ignores `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` (the fuses in `electron-builder.yml`), and it quits at once when `app.asar` was changed. Debug the main process with `npm run dev -- --inspect 5858`.
- A window started from a remote shell does not always come to the front: Windows keeps the foreground for the window the user last used. Capture it with `PrintWindow` on its handle rather than a screenshot of the whole screen when another window covers it.
- Settings, memory and jobs live in `%APPDATA%\asist`; installing over an older version keeps them. Uninstall from Windows Settings > Apps, or with `%LOCALAPPDATA%\Programs\asist\Uninstall ASIST.exe /S`.
