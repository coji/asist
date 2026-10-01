import { resourcePath } from './resource-path'

/**
 * The binaries the local speech runs on, which scripts/resources puts under resources and
 * electron-builder.yml ships: llama.cpp's llama-server for the speech recognition and speech.cpp's worker
 * for the speech synthesis.
 */

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)

export function llamaServerPath(): string {
  return resourcePath(`llama.cpp/${exe('llama-server')}`)
}

export function speechWorkerPath(): string {
  return resourcePath(`speech-worker/${exe('speech-worker')}`)
}
