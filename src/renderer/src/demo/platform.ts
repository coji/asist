import { nvidiaGpuSupport, type NvidiaGpuSupport } from '@shared/nvidia-gpu'
import {
  SPEECH_RUNTIME_UNAVAILABLE_TEXT,
  deriveCapabilities,
  type Machine,
  type OsFamily,
  type PlatformCapabilities,
  type SpeechRuntimeUnavailable
} from '@shared/platform'

/**
 * The machine the demo pretends to run on. `?os=windows` gives the screens the capabilities of an x64
 * Windows PC with an RTX 2080, so what Windows offers can be looked at on a Mac, and `?gpu=` with a reason
 * such as `no-nvidia-gpu` takes that GPU away; without them the demo is an Apple Silicon Mac.
 */

type DemoMachine = Omit<Machine, 'nvidiaGpu'>

const MACHINES: Record<OsFamily, DemoMachine> = {
  macos: { platform: 'darwin', arch: 'arm64', totalMemoryBytes: 32 * 1024 ** 3 },
  windows: { platform: 'win32', arch: 'x64', totalMemoryBytes: 32 * 1024 ** 3 }
}

/** What nvidia-smi prints for the GPU of the Windows machine the port was measured on. */
const DEMO_NVIDIA_SMI = 'NVIDIA GeForce RTX 2080, 8192, 591.86, 7.5'

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

/** The GPU the query leaves the Windows demo: the RTX 2080, or none for the reason `?gpu=` names. */
export function demoNvidiaGpu(search: string): NvidiaGpuSupport {
  const reason = new URLSearchParams(search).get('gpu')
  if (reason === null) return nvidiaGpuSupport(DEMO_NVIDIA_SMI)
  const reasons = Object.keys(SPEECH_RUNTIME_UNAVAILABLE_TEXT)
  if (!reasons.includes(reason)) throw new Error(`GPU は ${reasons.join(' / ')} で指定します: ${reason}`)
  return { usable: false, reason: reason as SpeechRuntimeUnavailable }
}

/** The capabilities of the machine the query names. */
export const demoCapabilities = (search: string): PlatformCapabilities =>
  deriveCapabilities({ ...MACHINES[demoOs(search)], nvidiaGpu: () => demoNvidiaGpu(search) })
