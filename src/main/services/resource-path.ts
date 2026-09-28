import path from 'node:path'
import { app } from 'electron'
import type { OsFamily } from '@shared/platform'

/** A file or folder the app ships under resources/, in the installed app and in a checkout alike. */
export function resourcePath(name: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, name) : path.join(app.getAppPath(), 'resources', name)
}

/**
 * A native helper built for one OS. The installed app has it at the top of its resources, and a checkout
 * has it in resources/native/<os>, where the build of the helpers puts it.
 */
export function nativeHelperPath(os: OsFamily, file: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, file) : path.join(app.getAppPath(), 'resources', 'native', os, file)
}
