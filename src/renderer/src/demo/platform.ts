import { deriveCapabilities, type Machine, type OsFamily, type PlatformCapabilities } from '@shared/platform'

/**
 * The machine the demo pretends to run on. `?os=windows` gives the screens the capabilities of an x64
 * Windows PC, so what Windows offers can be looked at on a Mac; without it the demo is an Apple Silicon Mac.
 */

const MACHINES: Record<OsFamily, Machine> = {
  macos: { platform: 'darwin', arch: 'arm64', totalMemoryBytes: 32 * 1024 ** 3 },
  windows: { platform: 'win32', arch: 'x64', totalMemoryBytes: 32 * 1024 ** 3 }
}

export const DEMO_OSES = Object.keys(MACHINES) as OsFamily[]
export const DEFAULT_DEMO_OS: OsFamily = 'macos'

export function isDemoOs(value: string): value is OsFamily {
  return (DEMO_OSES as string[]).includes(value)
}

/** The OS the query names. A name that is not one fails, rather than quietly showing the Mac. */
export function demoOs(search: string): OsFamily {
  const os = new URLSearchParams(search).get('os') ?? DEFAULT_DEMO_OS
  if (!isDemoOs(os)) throw new Error(`OS は ${DEMO_OSES.join(' / ')} で指定します: ${os}`)
  return os
}

export const demoCapabilities = (os: OsFamily): PlatformCapabilities => deriveCapabilities(MACHINES[os])
