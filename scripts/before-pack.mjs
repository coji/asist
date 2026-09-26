import { Arch } from 'electron-builder'
import { requirePackagingHost } from './resources/targets.mjs'

/** The beforePack hook of electron-builder.yml, which runs before anything is copied for each platform and architecture. */
export default function beforePack(context) {
  requirePackagingHost({ platform: context.electronPlatformName, arch: Arch[context.arch] }, { platform: process.platform, arch: process.arch })
}
