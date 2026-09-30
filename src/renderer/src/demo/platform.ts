import { LOCAL_SPEECH_UNAVAILABLE_TEXT, deriveCapabilities, type Machine, type OsFamily, type PlatformCapabilities } from '@shared/platform'
import type { SpeechDevice } from '@shared/speech-devices'

/**
 * The machine the demo pretends to run on. `?os=windows` gives the screens the capabilities of an x64
 * Windows PC with an RTX 2080, so what Windows offers can be looked at on a Mac, and `?gpu=` with a reason
 * such as `no-discrete-gpu` takes that GPU away; without them the demo is an Apple Silicon Mac.
 */

type DemoMachine = Omit<Machine, 'speechDevices'>

// The Windows PC's microphone has echo cancellation on, so the demo shows the settings that go with the
// native microphone on both systems.
const MACHINES: Record<OsFamily, DemoMachine> = {
  macos: { platform: 'darwin', arch: 'arm64', totalMemoryBytes: 32 * 1024 ** 3, micCancelsEcho: () => true },
  windows: { platform: 'win32', arch: 'x64', totalMemoryBytes: 32 * 1024 ** 3, micCancelsEcho: () => true }
}

/** The devices `qwen3-tts-worker --devices` lists on the Windows machine the port was measured on. */
const DEMO_DEVICES: SpeechDevice[] = [
  { name: 'Vulkan0', description: 'NVIDIA GeForce RTX 2080', kind: 'gpu', memoryTotal: 8 * 1024 ** 3 },
  { name: 'CPU', description: 'Intel(R) Core(TM) i9-9900K CPU @ 3.60GHz', kind: 'cpu', memoryTotal: 32 * 1024 ** 3 }
]

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

/** The devices the query leaves the Windows demo: with the RTX 2080, or as `?gpu=` names the reason there is none. */
export function demoSpeechDevices(search: string): SpeechDevice[] | null {
  const reason = new URLSearchParams(search).get('gpu')
  if (reason === null) return DEMO_DEVICES
  const reasons = Object.keys(LOCAL_SPEECH_UNAVAILABLE_TEXT)
  if (!reasons.includes(reason)) throw new Error(`GPU は ${reasons.join(' / ')} で指定します: ${reason}`)
  return reason === 'gpu-check-failed' ? null : DEMO_DEVICES.filter((device) => device.kind !== 'gpu')
}

/** The capabilities of the machine the query names. */
export const demoCapabilities = (search: string): PlatformCapabilities =>
  deriveCapabilities({
    ...MACHINES[demoOs(search)],
    speechDevices: () => demoSpeechDevices(search)
  })
