import { createRequire } from 'node:module'
import path from 'node:path'
import { prepareGitMacos } from './git-macos.mjs'
import { prepareGitWindows } from './git-windows.mjs'
import { prepareLlamaCpp } from './llama-cpp.mjs'
import { prepareNativeMacos } from './native-macos.mjs'
import { prepareNativeWindows } from './native-windows.mjs'
import { run } from './shared.mjs'
import { prepareSpeechWorker } from './speech-worker.mjs'
import { prepareUv } from './uv.mjs'

// electron downloads its binary the first time it is required, not on install. Test workers that required
// it at the same time failed forty tests with half-written downloads, and electron-vite dev never requires
// it: it reads the binary's path from path.txt and stops with "Electron uninstall" when that file is missing.
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
    test: [prepareGitMacos, prepareUv, prepareElectron],
    dev: [prepareGitMacos, prepareUv, prepareLlamaCpp, prepareSpeechWorker, prepareNativeMacos, prepareElectron],
    build: [prepareGitMacos, prepareUv, prepareLlamaCpp, prepareSpeechWorker, prepareNativeMacos, preparePermissionTexts],
    check: [prepareUv, prepareLlamaCpp, prepareSpeechWorker]
  },
  'win32-x64': {
    test: [prepareGitWindows, prepareUv, prepareNativeWindows, prepareElectron],
    dev: [prepareGitWindows, prepareUv, prepareLlamaCpp, prepareSpeechWorker, prepareNativeWindows, prepareElectron],
    build: [prepareGitWindows, prepareUv, prepareLlamaCpp, prepareSpeechWorker, prepareNativeWindows],
    check: [prepareGitWindows, prepareUv, prepareLlamaCpp, prepareSpeechWorker]
  }
}

const SYSTEM_NAMES = { darwin: 'macOS', win32: 'Windows' }

const machine = ({ platform, arch }) => `${SYSTEM_NAMES[platform] ?? platform} ${arch}`

/**
 * Throws unless the app is packaged for the platform and architecture of the machine that packages it. The
 * steps above prepare the tools of the machine they run on, so an app packaged for another one would carry
 * a git, a uv and native helpers that cannot run there.
 */
export function requirePackagingHost(target, host) {
  if (target.platform === host.platform && target.arch === host.arch) return
  throw new Error(
    `ASIST for ${machine(target)} has to be packaged on ${machine(target)}: this machine is ${machine(host)}, and the bundled git, uv and native helpers are prepared for the machine that packages the app`
  )
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
