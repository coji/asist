import { nvidiaGpuSupport } from '@shared/nvidia-gpu'
import { deriveCapabilities, type PlatformCapabilities } from '@shared/platform'

const GIB = 1024 ** 3

/** nvidia-smi is run only on Windows, so a Mac that asked for it would be a defect. */
const noNvidiaSmi = (): never => {
  throw new Error('nvidia-smi is not run on a Mac')
}

/** The microphone check is run only on Windows, so a Mac that asked for it would be a defect. */
const noMicCheck = (): never => {
  throw new Error('the microphone check is not run on a Mac')
}

/** Only ASIST_CALENDAR_BACKEND=google asks whether the build has Google's OAuth client. */
const noGoogleClient = (): never => {
  throw new Error('the Google client is asked for only when Google Calendar is')
}

/** No ASIST_CALENDAR_BACKEND. */
const osCalendar = { calendarBackend: undefined, googleClient: noGoogleClient }

/** The capabilities of a 32 GB Apple Silicon Mac. */
export const MACOS = deriveCapabilities({ platform: 'darwin', arch: 'arm64', totalMemoryBytes: 32 * GIB, nvidiaGpu: noNvidiaSmi, micCancelsEcho: noMicCheck, ...osCalendar })

/**
 * An x64 Windows PC with an 8 GB RTX 2080, the machine the CUDA runtime was measured on, whose microphone
 * Windows does not cancel the echo on, so that it captures through getUserMedia.
 */
export const WINDOWS = deriveCapabilities({
  platform: 'win32',
  arch: 'x64',
  totalMemoryBytes: 32 * GIB,
  nvidiaGpu: () => nvidiaGpuSupport('NVIDIA GeForce RTX 2080, 8192, 591.86, 7.5'),
  micCancelsEcho: () => false,
  ...osCalendar
})

/** An x64 Windows PC where nvidia-smi could not run, so that it has no local speech models. */
export const WINDOWS_WITHOUT_GPU = deriveCapabilities({
  platform: 'win32',
  arch: 'x64',
  totalMemoryBytes: 32 * GIB,
  nvidiaGpu: () => nvidiaGpuSupport(null),
  micCancelsEcho: () => false,
  ...osCalendar
})

/**
 * The fixture of the system the tests run on, for tests that run its real git or uv. Main's own
 * capabilities would run nvidia-smi and open the real microphone on Windows.
 */
export const HOST = process.platform === 'win32' ? WINDOWS : MACOS

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
