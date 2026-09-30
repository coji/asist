#!/bin/sh
# Put a signed build into /Applications/ASIST.app.
# Usage: install.sh [--build] [--replace-running] [--launch [--cdp]]
#   --build            check the signing identity, then run npm run dist:mac (without it, the existing build in dist/mac-arm64)
#   --replace-running  quit a running ASIST and replace it (without it, stop when one is running)
#   --launch           after installing, start with --enable-logging and print where the log is
#   --cdp              with --launch, also open the DevTools protocol on port 9222 (only while checking, since any local process can drive the app through it)
# Environment variables: CSC_NAME (the name after "Developer ID Application: " of the signing identity; without it, the only such identity in the keychain), ASIST_LOG (where the launch log goes)
set -eu
repo=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$repo"
build=0
replace=0
launch=0
cdp=0
for arg in "$@"; do
  case $arg in
    --build) build=1 ;;
    --replace-running) replace=1 ;;
    --launch) launch=1 ;;
    --cdp) cdp=1 ;;
    *) echo "不明な引数: $arg" >&2; exit 1 ;;
  esac
done
if [ $cdp = 1 ] && [ $launch = 0 ]; then
  echo "--cdp は --launch と一緒に指定します" >&2
  exit 1
fi

app=dist/mac-arm64/ASIST.app
if [ $build = 1 ]; then
  if [ -z "${CSC_NAME:-}" ]; then
    # electron-builder refuses a name that starts with "Developer ID Application:" and picks that kind of
    # certificate itself, so only the name after it is passed on.
    found=$(security find-identity -v -p codesigning | sed -n 's/.*"Developer ID Application: \([^"]*\)".*/\1/p' | sort -u)
    if [ "$(printf '%s\n' "$found" | grep -c .)" != 1 ]; then
      echo "Developer ID Application の署名identityが一つに決まりません。CSC_NAME で指定してください" >&2
      security find-identity -v -p codesigning >&2
      exit 1
    fi
    CSC_NAME=$found
  fi
  if ! security find-identity -v -p codesigning | grep -Fq "\"Developer ID Application: $CSC_NAME\""; then
    echo "署名identityが見つかりません: $CSC_NAME" >&2
    echo "security find-identity -v -p codesigning で確かめ、CSC_NAME で指定してください" >&2
    exit 1
  fi
  CSC_NAME="$CSC_NAME" npm run dist:mac
fi
if [ ! -d "$app" ]; then
  echo "ビルドがありません: $app(--build を付けてください)" >&2
  exit 1
fi
# The released app is signed with Developer ID, and macOS ties the microphone permission to that
# signature, so a build signed otherwise would lose it on every switch between the two.
if ! codesign -dvv "$app" 2>&1 | grep -q "Authority=Developer ID Application"; then
  echo "$app は Developer ID で署名されていません。リリース版とマイクの許可を共有できないので入れません" >&2
  exit 1
fi

if pgrep -f "ASIST.app/Contents/MacOS/ASIST" >/dev/null; then
  if [ $replace = 1 ]; then
    pkill -f "ASIST.app/Contents/MacOS/ASIST"
    sleep 2
  else
    echo "ASIST が動いています。--replace-running を付けるか、終了してから実行してください" >&2
    exit 1
  fi
fi

rm -rf /Applications/ASIST.app
ditto "$app" /Applications/ASIST.app
echo "installed /Applications/ASIST.app from $(git rev-parse --short HEAD) at $(date '+%Y-%m-%d %H:%M')"

if [ $launch = 1 ]; then
  # Starting the executable directly attaches the microphone permission (TCC) to the parent shell,
  # and it stops working. Starting through open, via LaunchServices, makes it the app's own.
  # stdout/stderr go to a file to keep the main and renderer logs.
  log=${ASIST_LOG:-/tmp/asist-$(date +%Y%m%d-%H%M%S).log}
  if [ $cdp = 1 ]; then
    open -a /Applications/ASIST.app --stdout "$log" --stderr "$log" --args --enable-logging --remote-debugging-port=9222
    echo "launched via open with logging: $log (CDP: http://127.0.0.1:9222/json)"
  else
    open -a /Applications/ASIST.app --stdout "$log" --stderr "$log" --args --enable-logging
    echo "launched via open with logging: $log"
  fi
fi
