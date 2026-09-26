import { createRequire } from 'node:module'
import path from 'node:path'
import { prepareGitMacos } from './git-macos.mjs'
import { prepareGitWindows } from './git-windows.mjs'
import { prepareNativeMacos } from './native-macos.mjs'
import { prepareNativeWindows } from './native-windows.mjs'
import { run } from './shared.mjs'
import { prepareUv } from './uv.mjs'

// electron downloads its binary the first time it is required, not on install, and test workers that
// required it at the same time failed forty tests with half-written downloads.
function prepareElectron({ root }) {
  run(process.execPath, [createRequire(import.meta.url).resolve('electron/install.js')], { cwd: root })
}

function preparePermissionTexts({ root }) {
  run(process.execPath, [path.join(root, 'scripts', 'macos', 'permission-texts.mjs')], { cwd: root })
}

/**
 * What each purpose prepares on each platform and architecture the app is built for. check lists what
 * can be fetched and unpacked on any machine, to try the downloads of another platform.
 */
export const TARGETS = {
  'darwin-arm64': {
    test: [prepareGitMacos, prepareElectron],
    dev: [prepareGitMacos, prepareUv, prepareNativeMacos],
    build: [prepareGitMacos, prepareUv, prepareNativeMacos, preparePermissionTexts],
    check: [prepareUv]
  },
  'win32-x64': {
    test: [prepareGitWindows, prepareElectron],
    dev: [prepareGitWindows, prepareUv, prepareNativeWindows],
    build: [prepareGitWindows, prepareUv, prepareNativeWindows],
    check: [prepareGitWindows, prepareUv]
  }
}

/** The steps of purpose on a platform and architecture. Anything the app is not built for throws. */
export function stepsFor(purpose, platform, arch) {
  const target = TARGETS[`${platform}-${arch}`]
  if (!target) {
    throw new Error(
      `ASIST is built for macOS arm64 and Windows x64, not ${platform} ${arch}, so the bundled git, uv and native helpers cannot be prepared here`
    )
  }
  const steps = target[purpose]
  if (!steps) throw new Error(`unknown purpose ${purpose}; use dev, build, test or check`)
  return steps
}
