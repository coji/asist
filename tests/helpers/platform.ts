import { deriveCapabilities, type PlatformCapabilities } from '@shared/platform'

/** The capabilities of a 32 GB Apple Silicon Mac and of an x64 Windows PC. */
export const MACOS = deriveCapabilities({ platform: 'darwin', arch: 'arm64', totalMemoryBytes: 32 * 1024 ** 3 })
export const WINDOWS = deriveCapabilities({ platform: 'win32', arch: 'x64', totalMemoryBytes: 32 * 1024 ** 3 })

let current: PlatformCapabilities = MACOS

/**
 * Stands in for the platform module of the main process and of the renderer, so that a test decides
 * the machine rather than the one it runs on: `vi.mock('@/platform', () => import('./helpers/platform'))`.
 */
export const platformCapabilities = (): PlatformCapabilities => current
export const loadPlatformCapabilities = async (): Promise<void> => {}

/** Makes the mocked module answer with these capabilities until the next call. */
export function setCapabilities(capabilities: PlatformCapabilities): void {
  current = capabilities
}
