import { nvidiaGpuSupport } from '@shared/nvidia-gpu'
import { deriveCapabilities, type PlatformCapabilities } from '@shared/platform'

const GIB = 1024 ** 3

/** nvidia-smi is run only on Windows, so a Mac that asked for it would be a defect. */
const noNvidiaSmi = (): never => {
  throw new Error('nvidia-smi is not run on a Mac')
}

/** The capabilities of a 32 GB Apple Silicon Mac. */
export const MACOS = deriveCapabilities({ platform: 'darwin', arch: 'arm64', totalMemoryBytes: 32 * GIB, nvidiaGpu: noNvidiaSmi })

/** An x64 Windows PC with an 8 GB RTX 2080, the machine the CUDA runtime was measured on. */
export const WINDOWS = deriveCapabilities({
  platform: 'win32',
  arch: 'x64',
  totalMemoryBytes: 32 * GIB,
  nvidiaGpu: () => nvidiaGpuSupport('NVIDIA GeForce RTX 2080, 8192, 591.86, 7.5')
})

/** An x64 Windows PC where nvidia-smi could not run, so that it has no local speech models. */
export const WINDOWS_WITHOUT_GPU = deriveCapabilities({ platform: 'win32', arch: 'x64', totalMemoryBytes: 32 * GIB, nvidiaGpu: () => nvidiaGpuSupport(null) })

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
