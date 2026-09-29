/**
 * The devices the local speech binaries can run on, as `qwen3-tts-worker --devices` lists them, and the
 * choice of the one to run on. llama-server and qwen3-tts-worker are built on the same ggml, so they list
 * the devices under the same names in the same order.
 */

/** One device of the list. `kind` is ggml's: a discrete GPU, an integrated one, or the CPU. */
export interface SpeechDevice {
  name: string
  description: string
  kind: 'gpu' | 'igpu' | 'cpu'
  memoryTotal: number
}

/** The line of the device list, which the worker prints with the prefix of its protocol. */
const DEVICES_PREFIX = 'ASIST_JSON:'

/** The devices in the output of `qwen3-tts-worker --devices`, or null when it holds no list that reads. */
export function parseSpeechDevices(output: string): SpeechDevice[] | null {
  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith(DEVICES_PREFIX))
  if (!line) return null
  let message: unknown
  try {
    message = JSON.parse(line.slice(DEVICES_PREFIX.length))
  } catch {
    return null
  }
  const devices = (message as { type?: unknown; devices?: unknown }).devices
  if ((message as { type?: unknown }).type !== 'devices' || !Array.isArray(devices)) return null
  const read: SpeechDevice[] = []
  for (const device of devices as Array<Record<string, unknown>>) {
    const { name, description, kind, memoryTotal } = device
    if (typeof name !== 'string' || typeof description !== 'string' || typeof memoryTotal !== 'number') return null
    if (kind !== 'gpu' && kind !== 'igpu' && kind !== 'cpu') return null
    read.push({ name, description, kind, memoryTotal })
  }
  return read
}

/** The GPU the local speech models run on, with its memory in GB, or null when there is no discrete GPU. */
export function chooseSpeechDevice(devices: readonly SpeechDevice[]): { device: string; memoryGb: number } | null {
  // An integrated GPU shares the machine's memory and has not been measured to keep up with speech, so
  // only a discrete one counts; with several, the one with the most memory holds the models best.
  const discrete = devices.filter((device) => device.kind === 'gpu')
  if (discrete.length === 0) return null
  const best = discrete.reduce((a, b) => (b.memoryTotal > a.memoryTotal ? b : a))
  return { device: best.name, memoryGb: Math.round(best.memoryTotal / 1024 ** 3) }
}
