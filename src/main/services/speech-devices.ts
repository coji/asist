import { execFileSync } from 'node:child_process'
import { parseSpeechDevices, type SpeechDevice } from '@shared/speech-devices'
import { childEnv } from './child-env'
import { speechWorkerPath } from './speech-binaries'

/**
 * Listing the devices starts every GPU driver ggml was built for: under a second on an RTX 2080 with
 * Vulkan (2026-09-29). A driver that hangs, as one can while it is being replaced, would otherwise hold
 * up the launch.
 */
const DEVICE_LIST_TIMEOUT_MS = 30_000

/**
 * The devices the local speech binaries can run on, from `speech-worker --devices`, or null when the
 * worker could not list them. Asked on Windows only.
 */
export function listSpeechDevices(): SpeechDevice[] | null {
  let output: string
  try {
    output = execFileSync(speechWorkerPath(), ['--devices'], {
      encoding: 'utf8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: DEVICE_LIST_TIMEOUT_MS,
      windowsHide: true
    })
  } catch (error) {
    console.error('speech-worker could not list the devices:', error)
    return null
  }
  const devices = parseSpeechDevices(output)
  if (devices === null) console.error('speech-worker printed no device list that could be read:', output)
  return devices
}
