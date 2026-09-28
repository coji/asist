/**
 * Why this machine's NVIDIA GPU cannot run the local speech runtime on Windows. gpu-check-failed is
 * nvidia-smi failing for a reason other than finding no GPU, such as a driver that is not running or a
 * check that timed out, which a restart or a working driver can clear.
 */
export type NvidiaGpuUnavailable = 'no-nvidia-gpu' | 'driver-too-old' | 'gpu-too-old' | 'gpu-check-failed'

/** Whether the local speech runtime can run on this machine's NVIDIA GPU, with the GPU it runs on. */
export type NvidiaGpuSupport =
  | { usable: true; name: string; memoryGb: number }
  | { usable: false; reason: NvidiaGpuUnavailable }

/** The arguments of nvidia-smi that print one line per GPU in the columns `nvidiaGpuSupport` reads. */
export const NVIDIA_SMI_QUERY = ['--query-gpu=name,memory.total,driver_version,compute_cap', '--format=csv,noheader,nounits']

/** torch built for CUDA 13.0 needs an NVIDIA driver of this branch or later. */
const MIN_DRIVER = 580

/** CUDA 13.0 dropped the GPUs before Turing (RTX 20), whose compute capability is 7.5. */
const MIN_COMPUTE_CAPABILITY = { major: 7, minor: 5 }

interface NvidiaGpu {
  name: string
  memoryMib: number
  driver: number
  computeCapability: { major: number; minor: number }
}

/** A line such as `NVIDIA GeForce RTX 2080, 8192, 591.86, 7.5`, or null for one that does not read as a GPU. */
function readLine(line: string): NvidiaGpu | null {
  const fields = line.split(',').map((field) => field.trim())
  if (fields.length < 4) return null
  // The name comes first and is the only field that could hold a comma, so the numbers are read from the end.
  const [memory, driver, capability] = fields.slice(-3)
  const name = fields.slice(0, -3).join(', ')
  const capabilityParts = /^(\d+)\.(\d+)$/.exec(capability)
  if (!name || !/^\d+$/.test(memory) || !/^\d+(\.\d+)*$/.test(driver) || !capabilityParts) return null
  return {
    name,
    memoryMib: Number(memory),
    driver: Number.parseInt(driver, 10),
    computeCapability: { major: Number(capabilityParts[1]), minor: Number(capabilityParts[2]) }
  }
}

/**
 * Decides from the output of nvidia-smi run with `NVIDIA_SMI_QUERY` whether the local speech runtime can
 * run here. A line that does not read as a GPU counts as no GPU.
 */
export function nvidiaGpuSupport(output: string): NvidiaGpuSupport {
  const gpus = output.split(/\r?\n/).map(readLine).filter((gpu) => gpu !== null)
  if (gpus.length === 0) return { usable: false, reason: 'no-nvidia-gpu' }
  // nvidia-smi lists the GPUs in PCI bus order, and the worker, with CUDA_DEVICE_ORDER=PCI_BUS_ID, runs on
  // the first GPU of compute capability 7.5 or higher in the same order, so the memory reported is that
  // of the GPU the model is loaded on.
  const gpu = gpus.find(({ computeCapability: { major, minor } }) =>
    major > MIN_COMPUTE_CAPABILITY.major || (major === MIN_COMPUTE_CAPABILITY.major && minor >= MIN_COMPUTE_CAPABILITY.minor))
  // A newer driver would not help a GPU CUDA 13.0 no longer supports, so the GPU is judged first.
  if (!gpu) return { usable: false, reason: 'gpu-too-old' }
  if (gpu.driver < MIN_DRIVER) return { usable: false, reason: 'driver-too-old' }
  return { usable: true, name: gpu.name, memoryGb: Math.round(gpu.memoryMib / 1024) }
}
