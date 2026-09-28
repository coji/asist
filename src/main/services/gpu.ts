import { execFileSync } from 'node:child_process'
import { NVIDIA_SMI_QUERY, nvidiaGpuSupport, type NvidiaGpuSupport } from '@shared/nvidia-gpu'
import { childEnv } from './child-env'

/**
 * nvidia-smi answers in well under a second; one that hangs, as it can while the driver is being
 * replaced, would otherwise hold up whatever waits for the answer.
 */
const NVIDIA_SMI_TIMEOUT_MS = 10_000

/**
 * The exit status with which nvidia-smi reports that it found no device, printing "No devices were found"
 * on its standard output. Measured on Windows 11 with driver 591.86 (2026-09-29), asked for a GPU index
 * the machine does not have.
 */
const NVIDIA_SMI_NO_DEVICE = 6

/**
 * Whether this machine's NVIDIA GPU can run the local speech runtime, read from nvidia-smi. Drivers from
 * 580 on install nvidia-smi.exe in System32, which is on every PATH; older ones put it elsewhere, but
 * those are too old for the runtime anyway, so nvidia-smi not being found means no usable GPU. Any other
 * failure is a failed check rather than a missing GPU.
 */
export function detectNvidiaGpu(): NvidiaGpuSupport {
  let output: string
  try {
    output = execFileSync('nvidia-smi', NVIDIA_SMI_QUERY, {
      encoding: 'utf8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NVIDIA_SMI_TIMEOUT_MS,
      windowsHide: true
    })
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { status?: number | null }
    if (failure.code === 'ENOENT' || failure.status === NVIDIA_SMI_NO_DEVICE) return { usable: false, reason: 'no-nvidia-gpu' }
    console.error('nvidia-smi could not report the GPUs:', error)
    return { usable: false, reason: 'gpu-check-failed' }
  }
  const support = nvidiaGpuSupport(output)
  if (!support.usable && support.reason === 'no-nvidia-gpu' && output.trim()) {
    console.error('nvidia-smi printed no GPU that could be read:', output)
  }
  return support
}
