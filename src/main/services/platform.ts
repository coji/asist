import os from 'node:os'
import { deriveCapabilities, type PlatformCapabilities } from '@shared/platform'

let capabilities: PlatformCapabilities | null = null

/**
 * What this machine can run, derived on the first call and kept for the life of the process. The
 * startup calls it before anything else, so an OS or CPU the app is not built for stops the launch
 * with its reason.
 */
export function platformCapabilities(): PlatformCapabilities {
  capabilities ??= deriveCapabilities({ platform: process.platform, arch: process.arch, totalMemoryBytes: os.totalmem() })
  return capabilities
}
