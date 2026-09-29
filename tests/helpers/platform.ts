import { deriveCapabilities, type PlatformCapabilities } from '@shared/platform'
import type { SpeechDevice } from '@shared/speech-devices'

const GIB = 1024 ** 3

/** The device list is read only on Windows, so a Mac that asked for it would be a defect. */
const noDeviceList = (): never => {
  throw new Error('the speech devices are not listed on a Mac')
}

/** What `qwen3-tts-worker --devices` lists on the Windows PC the port was measured on. */
const RTX_2080_DEVICES: SpeechDevice[] = [
  { name: 'Vulkan0', description: 'NVIDIA GeForce RTX 2080', kind: 'gpu', memoryTotal: 8 * GIB },
  { name: 'CPU', description: 'Intel(R) Core(TM) i9-9900K CPU @ 3.60GHz', kind: 'cpu', memoryTotal: 32 * GIB }
]

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
export const MACOS = deriveCapabilities({ platform: 'darwin', arch: 'arm64', totalMemoryBytes: 32 * GIB, speechDevices: noDeviceList, micCancelsEcho: noMicCheck, ...osCalendar })

/**
 * An x64 Windows PC with an 8 GB RTX 2080, the machine the local speech was measured on, whose microphone
 * Windows does not cancel the echo on, so that it captures through getUserMedia.
 */
export const WINDOWS = deriveCapabilities({
  platform: 'win32',
  arch: 'x64',
  totalMemoryBytes: 32 * GIB,
  speechDevices: () => RTX_2080_DEVICES,
  micCancelsEcho: () => false,
  ...osCalendar
})

/** An x64 Windows PC with no discrete GPU, so that it has no local speech models. */
export const WINDOWS_WITHOUT_GPU = deriveCapabilities({
  platform: 'win32',
  arch: 'x64',
  totalMemoryBytes: 32 * GIB,
  speechDevices: () => RTX_2080_DEVICES.filter((device) => device.kind !== 'gpu'),
  micCancelsEcho: () => false,
  ...osCalendar
})

/**
 * The fixture of the system the tests run on, for tests that run its real git or uv. Main's own
 * capabilities would run the speech worker and open the real microphone on Windows.
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
