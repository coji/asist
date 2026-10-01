import type { MessageKey } from './i18n'
import { errorText } from './i18n/error-text'
import { chooseSpeechDevice, type SpeechDevice } from './speech-devices'

/**
 * What this OS and this machine can run, decided once in the main process and handed to the renderer
 * and to the model's tools. A feature that is not available here is left out of the screens and of the
 * tool list rather than shown and failing when used.
 */

export type OsFamily = 'macos' | 'windows'

/**
 * The GPU interface the local speech models run on: Metal on an Apple Silicon Mac, Vulkan on Windows.
 * llama-server runs the speech recognition and speech-worker the speech synthesis, both built on ggml.
 */
export type SpeechBackend = 'metal' | 'vulkan'

/**
 * Why this machine cannot run the local speech models, which the screens show in place of the choice.
 * Only Windows can lack them: it has no discrete GPU, or listing the devices failed.
 */
export type LocalSpeechUnavailable = 'no-discrete-gpu' | 'gpu-check-failed'

/** The sentence the screens show, and an error carries, for each reason. */
export const LOCAL_SPEECH_UNAVAILABLE_TEXT = {
  'no-discrete-gpu': 'speechRecognition.unavailable.noDiscreteGpu',
  'gpu-check-failed': 'speechRecognition.unavailable.gpuCheckFailed'
} as const satisfies Record<LocalSpeechUnavailable, MessageKey>

/** The device ggml names the GPU of an Apple Silicon Mac. */
const METAL_DEVICE = 'MTL0'

export interface PlatformCapabilities {
  /**
   * For wording that names a part of the OS (Finder, File Explorer), and for main's own way of doing a
   * thing each OS does differently, such as where the agent CLIs are installed. No feature is gated on it.
   */
  os: OsFamily
  /**
   * Where the local speech models run: the backend, the device the binaries are told to use, and the
   * memory the models are loaded into; or why there is none. The memory is the Mac's own on metal, which
   * the models share with every other app, and the GPU's on vulkan; the recommendations are decided from
   * that number alone.
   */
  localSpeech: { backend: SpeechBackend; device: string; memoryGb: number } | { backend: null; reason: LocalSpeechUnavailable }
  /**
   * The native microphone helper, which captures with the echo of everything the machine plays cancelled:
   * voice processing on macOS, the communications echo canceller on Windows. Without it the renderer
   * captures through getUserMedia.
   */
  nativeMic: boolean
  /** The Electron accelerator of the global hotkey; the label on the screen is derived from it. */
  hotkey: string
}

export interface Machine {
  platform: string
  arch: string
  totalMemoryBytes: number
  /** Asked only on Windows, where it runs `speech-worker --devices`; null when that failed. */
  speechDevices: () => SpeechDevice[] | null
  /**
   * Whether the Windows microphone helper finds echo cancellation on for the default microphone, which main
   * answers by running the helper's check. It is asked on Windows alone: every macOS the app supports has
   * voice processing.
   */
  micCancelsEcho: () => boolean
}

/** The local speech of a Windows machine, from its device list. */
function windowsSpeech(devices: SpeechDevice[] | null): PlatformCapabilities['localSpeech'] {
  if (devices === null) return { backend: null, reason: 'gpu-check-failed' }
  const chosen = chooseSpeechDevice(devices)
  return chosen === null ? { backend: null, reason: 'no-discrete-gpu' } : { backend: 'vulkan', ...chosen }
}

/**
 * The capabilities of a machine. Only Apple Silicon Macs and x64 Windows are built for; any other
 * combination fails, because a guess at what it can run would show features that then fail.
 */
export function deriveCapabilities(machine: Machine): PlatformCapabilities {
  const { platform, arch, totalMemoryBytes, speechDevices, micCancelsEcho } = machine
  if (platform === 'darwin' && arch === 'arm64') {
    return {
      os: 'macos',
      localSpeech: { backend: 'metal', device: METAL_DEVICE, memoryGb: Math.max(1, Math.round(totalMemoryBytes / 1024 ** 3)) },
      nativeMic: true,
      hotkey: 'Alt+Space'
    }
  }
  if (platform === 'win32' && arch === 'x64') {
    return {
      os: 'windows',
      localSpeech: windowsSpeech(speechDevices()),
      nativeMic: micCancelsEcho(),
      // On a Windows 11 machine with PowerToys, Copilot and Claude running (2026-09-27), Alt+Space and
      // Ctrl+Alt+Space were already taken, as were Ctrl+Win+Space and Win+Shift+Space, which switch the
      // input language. Ctrl+Shift+Space was free but is a key inside Word and VS Code.
      hotkey: 'Alt+Shift+Space'
    }
  }
  throw new Error(errorText('app.startup.unsupportedPlatform', { platform, arch }))
}

/** The symbols macOS menus write the modifier keys with. */
const MAC_MODIFIERS: Record<string, string> = { Ctrl: '⌃', Control: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Cmd: '⌘', Command: '⌘', CommandOrControl: '⌘', CmdOrCtrl: '⌘' }

/** The modifier Electron reads as ⌘ on macOS and as Ctrl on Windows, as Windows writes it. */
const WINDOWS_MODIFIERS: Record<string, string> = { CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl' }

/** An Electron accelerator as this OS writes a shortcut: ⌥Space or ⌘S on macOS, Alt+Shift+Space or Ctrl+S on Windows. */
export function shortcutLabel(os: OsFamily, accelerator: string): string {
  const parts = accelerator.split('+')
  if (os === 'windows') return parts.map((part) => WINDOWS_MODIFIERS[part] ?? part).join('+')
  return parts.map((part) => MAC_MODIFIERS[part] ?? part).join('')
}
