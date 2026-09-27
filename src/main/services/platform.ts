import os from 'node:os'
import { CALENDAR_BACKEND_VARIABLE, deriveCapabilities, type PlatformCapabilities } from '@shared/platform'
import { detectNvidiaGpu } from './gpu'
import { googleOAuthClient } from './google-oauth-client'
import { windowsMicCancelsEcho } from './mic-helper'

let capabilities: PlatformCapabilities | null = null

/**
 * What this machine can run, derived on the first call and kept for the life of the process. The
 * startup calls it before anything else, so an OS or CPU the app is not built for stops the launch
 * with its reason. A GPU or driver changed while the app runs is seen at the next launch.
 */
export function platformCapabilities(): PlatformCapabilities {
  capabilities ??= deriveCapabilities({
    platform: process.platform,
    arch: process.arch,
    totalMemoryBytes: os.totalmem(),
    nvidiaGpu: detectNvidiaGpu,
    micCancelsEcho: windowsMicCancelsEcho,
    calendarBackend: process.env[CALENDAR_BACKEND_VARIABLE],
    googleClient: () => googleOAuthClient() !== null
  })
  return capabilities
}
