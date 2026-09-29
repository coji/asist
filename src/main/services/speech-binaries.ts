import { resourcePath } from './resource-path'

/**
 * The binaries the local speech runs on, which scripts/resources puts under resources and
 * electron-builder.yml ships: llama.cpp's llama-server for the speech recognition and qwen3-tts-ggml's
 * worker for the speech synthesis.
 */

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)

export function llamaServerPath(): string {
  return resourcePath(`llama.cpp/${exe('llama-server')}`)
}

export function ttsWorkerPath(): string {
  return resourcePath(`qwen3-tts/${exe('qwen3-tts-worker')}`)
}
